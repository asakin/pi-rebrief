import type {
  ContextWithSystemEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";

export interface ContextFile {
  path: string;
  content: string;
}

export interface RebriefDeps {
  getAgentDir?: () => string;
  loadProjectContextFiles?: (options: { cwd: string; agentDir: string }) => ContextFile[];
  contextFilesDisabled?: () => boolean;
  startTimer?: (tick: () => void, ms: number) => () => void;
}

type Messages = ContextWithSystemEvent["messages"];

const STATUS_KEY = "pi-rebrief";
const POLL_MS = 3000;

// Check if Pi was started with --no-context-files (-nc); extensions can't read built-in flags
export function contextFilesDisabledByArgv(argv: readonly string[]): boolean {
  return argv.includes("--no-context-files") || argv.includes("-nc");
}

// Check if two sets of context files are the same
export function sameContextFiles(a: readonly ContextFile[], b: readonly ContextFile[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (left.path !== right.path || left.content !== right.content) return false;
  }
  return true;
}

// Show a path relative to cwd when inside it, else home-relative, else absolute
function displayPath(path: string, cwd: string, home: string): string {
  const rel = relative(cwd, path);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  if (home && path.startsWith(home + sep)) return `~${path.slice(home.length)}`;
  return path;
}

const MAX_LISTED = 3;

// Summarize which context files changed, were added, or were removed
export function describeChanges(
  previous: readonly ContextFile[],
  fresh: readonly ContextFile[],
  cwd: string,
  home: string = homedir(),
): string {
  const before = new Map(previous.map((file) => [file.path, file.content]));
  const after = new Set(fresh.map((file) => file.path));
  const entries: string[] = [];
  for (const file of fresh) {
    const old = before.get(file.path);
    if (old === undefined) entries.push(`added ${displayPath(file.path, cwd, home)}`);
    else if (old !== file.content) entries.push(`changed ${displayPath(file.path, cwd, home)}`);
  }
  for (const file of previous) {
    if (!after.has(file.path)) entries.push(`removed ${displayPath(file.path, cwd, home)}`);
  }
  if (entries.length === 0) return "order changed";

  // "changed a, b" instead of "changed a, changed b"
  const merged: string[] = [];
  let lastVerb = "";
  for (const entry of entries.slice(0, MAX_LISTED)) {
    const [verb] = entry.split(" ", 1);
    merged.push(verb === lastVerb ? entry.slice(verb!.length + 1) : entry);
    lastVerb = verb!;
  }
  const more = entries.length - MAX_LISTED;
  return more > 0 ? `${merged.join(", ")}, and ${more} more` : merged.join(", ");
}

// Format the number of context files into a human-readable string
function fileCountLabel(count: number): string {
  return `${count} context file${count === 1 ? "" : "s"}`;
}

// Clone the context files
function cloneContextFiles(files: readonly ContextFile[]): ContextFile[] {
  return files.map((file) => ({ path: file.path, content: file.content }));
}

// Render the project_context prompt section the way Pi does (Pi does not export its renderer)
export function renderProjectContext(files: readonly ContextFile[]): string | null {
  if (files.length === 0) return null;
  const body = [
    "Project-specific instructions and guidelines:",
    ...files.map(({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`),
  ].join("\n\n");
  return `<project_context>\n${body}\n</project_context>`;
}

// Add a request-local section update after the anchor message, unless the transcript already has these files
export function withContextUpdate(
  messages: Messages,
  files: readonly ContextFile[],
  anchorTimestamp: number | undefined,
  timestamp: number,
): Messages | undefined {
  const desired = renderProjectContext(files);
  const current = getCurrentSystemMessage(messages)?.sections?.project_context ?? null;
  if (current === desired) return undefined;
  const update = { role: "system" as const, content: "", sections: { project_context: desired }, timestamp };
  const anchor = anchorTimestamp === undefined ? -1 : messages.findIndex((m) => m.timestamp === anchorTimestamp);
  const at = anchor === -1 ? messages.length : anchor + 1;
  return [...messages.slice(0, at), update, ...messages.slice(at)];
}

function startInterval(tick: () => void, ms: number): () => void {
  const timer = setInterval(tick, ms);
  timer.unref?.();
  return () => clearInterval(timer);
}

// Create the rebrief extension
export function createRebriefExtension(deps: RebriefDeps = {}) {
  const resolveAgentDir = deps.getAgentDir ?? getAgentDir;
  const loadContextFiles = deps.loadProjectContextFiles ?? loadProjectContextFiles;
  const contextFilesDisabled = deps.contextFilesDisabled ?? (() => contextFilesDisabledByArgv(process.argv));
  const startTimer = deps.startTimer ?? startInterval;

  return function piRebrief(pi: ExtensionAPI) {
    // Files /rebrief loaded, applied at every run start
    let rebriefed: { cwd: string; files: ContextFile[] } | undefined;
    // What the session has loaded, compared against disk
    let loaded: ContextFile[] | undefined;
    // A /rebrief issued while a run was in progress; anchored after the newest message of the next request
    let pending: { files: ContextFile[]; anchorTimestamp?: number; timestamp: number } | undefined;
    let stopTimer: (() => void) | undefined;
    let stale = false;

    const setStale = (ui: ExtensionUIContext | undefined, next: boolean) => {
      if (next === stale || !ui) return;
      stale = next;
      ui.setStatus(STATUS_KEY, next ? `${ui.theme.fg("warning", "●")} context files changed — /rebrief` : undefined);
    };

    pi.on("session_start", (_event, ctx) => {
      rebriefed = undefined;
      pending = undefined;
      stale = false;
      stopTimer?.();
      stopTimer = undefined;
      if (contextFilesDisabled()) return;
      const ui = ctx.hasUI ? ctx.ui : undefined;
      const load = () => loadContextFiles({ cwd: ctx.cwd, agentDir: resolveAgentDir() });
      try {
        loaded = load();
      } catch {
        loaded = undefined;
      }
      stopTimer = startTimer(() => {
        if (!loaded) return;
        try {
          setStale(ui, !sameContextFiles(loaded, load()));
        } catch {
          // Unreadable for now; check again next tick
        }
      }, POLL_MS);
    });

    pi.on("session_shutdown", () => {
      stopTimer?.();
      stopTimer = undefined;
    });

    pi.registerCommand("rebrief", {
      description: "Reload only context files (lighter than /reload)",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        if (contextFilesDisabled()) {
          if (ctx.hasUI) {
            ctx.ui.notify("Context files are disabled (--no-context-files) — nothing to rebrief.", "warning");
          }
          return;
        }

        let freshFiles: ContextFile[];
        try {
          freshFiles = loadContextFiles({
            cwd: ctx.cwd,
            agentDir: resolveAgentDir(),
          });
        } catch (err) {
          if (ctx.hasUI) {
            const detail = err instanceof Error ? err.message : String(err);
            ctx.ui.notify(`Failed to reload context files: ${detail}`, "error");
          }
          return;
        }

        const previousFiles = loaded ?? ctx.getSystemPromptOptions?.().contextFiles ?? [];
        const changed = !sameContextFiles(previousFiles, freshFiles);
        const running = !ctx.isIdle();

        rebriefed = { cwd: ctx.cwd, files: cloneContextFiles(freshFiles) };
        loaded = cloneContextFiles(freshFiles);
        if (changed && running) {
          pending = { files: cloneContextFiles(freshFiles), timestamp: Date.now() };
        }

        if (!ctx.hasUI) return;
        setStale(ctx.ui, false);

        if (!changed) {
          ctx.ui.notify(`Context files unchanged (${fileCountLabel(freshFiles.length)}).`, "info");
          return;
        }

        const when = running ? " — applies to the running turn" : "";
        ctx.ui.notify(`Reloaded context files: ${describeChanges(previousFiles, freshFiles, ctx.cwd)}${when}.`, "info");
      },
    });

    pi.on("before_agent_start", async (event) => {
      pending = undefined;
      if (rebriefed && rebriefed.cwd === event.systemPromptOptions.cwd) {
        event.systemPromptOptions.contextFiles = cloneContextFiles(rebriefed.files);
      }
      loaded = cloneContextFiles(event.systemPromptOptions.contextFiles ?? []);
    });

    pi.on("context_with_system", (event) => {
      if (!pending) return;
      pending.anchorTimestamp ??= event.messages.at(-1)?.timestamp;
      const messages = withContextUpdate(event.messages, pending.files, pending.anchorTimestamp, pending.timestamp);
      return messages ? { messages } : undefined;
    });
  };
}

export default createRebriefExtension();
