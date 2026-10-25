import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { formatReloadedNotice, formatUnchangedNotice } from "./format.ts";

export { describeChanges } from "./format.ts";

export interface ContextFile {
  path: string;
  content: string;
}

export interface RebriefDeps {
  loadProjectContextFiles?: (options: { cwd: string; agentDir: string }) => ContextFile[];
  contextFilesDisabled?: () => boolean;
  startTimer?: (tick: () => void, ms: number) => () => void;
}

const STATUS_KEY = "pi-rebrief";
const POLL_MS = 3000; // How often to check for context file changes

// Check if Pi was started with --no-context-files (-nc); extensions can't read built-in flags
export function contextFilesDisabledByArgv(argv: readonly string[]): boolean {
  return argv.includes("--no-context-files") || argv.includes("-nc");
}

export function sameContextFiles(a: readonly ContextFile[], b: readonly ContextFile[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.path !== b[i]!.path || a[i]!.content !== b[i]!.content) {
      return false;
    }
  }
  return true;
}

// Render the project_context prompt section the way Pi does (Pi does not export its renderer)
export function renderProjectContext(files: readonly ContextFile[]): string | null {
  if (files.length === 0) {
    return null;
  }
  const body = [
    "Project-specific instructions and guidelines:",
    ...files.map(({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`),
  ].join("\n\n");
  return `<project_context>\n${body}\n</project_context>`;
}

function startInterval(tick: () => void, ms: number): () => void {
  const timer = setInterval(tick, ms);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function createRebriefExtension(deps: RebriefDeps = {}) {
  const loadContextFiles = deps.loadProjectContextFiles ?? loadProjectContextFiles;
  const contextFilesDisabled = deps.contextFilesDisabled ?? (() => contextFilesDisabledByArgv(process.argv));
  const startTimer = deps.startTimer ?? startInterval;

  return function piRebrief(pi: ExtensionAPI) {
    // The context files the session has
    let files: ContextFile[] = [];
    // The user ran /rebrief: stamp `files` onto every run
    let pinned = false;
    // A /rebrief issued while a run was in progress; anchored after the newest message of the next request
    let pending: { anchor?: number; at: number } | undefined;
    let stopTimer: (() => void) | undefined;
    let status: string | undefined;

    const load = (cwd: string) => loadContextFiles({ cwd, agentDir: getAgentDir() });

    const showStatus = (ui: ExtensionUIContext | undefined, stale: boolean) => {
      const next = stale ? `${ui?.theme.fg("warning", "●")} context files changed — /rebrief` : undefined;
      if (!ui || next === status) {
        return;
      }
      status = next;
      ui.setStatus(STATUS_KEY, next);
    };

    pi.on("session_start", (_event, ctx) => {
      pinned = false;
      pending = undefined;
      status = undefined;
      stopTimer?.();
      stopTimer = undefined;
      if (contextFilesDisabled()) {
        return;
      }
      const ui = ctx.hasUI ? ctx.ui : undefined;
      files = load(ctx.cwd);
      stopTimer = startTimer(() => showStatus(ui, !sameContextFiles(files, load(ctx.cwd))), POLL_MS);
    });

    pi.on("session_shutdown", () => {
      stopTimer?.();
      stopTimer = undefined;
    });

    pi.registerCommand("rebrief", {
      description: "Reload only context files (lighter than /reload)",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        const notify = (msg: string, level: "info" | "warning") => {
          if (ctx.hasUI) {
            ctx.ui.notify(msg, level);
          }
        };

        if (contextFilesDisabled()) {
          notify("Context files are disabled (--no-context-files) — nothing to rebrief.", "warning");
          return;
        }

        const previous = files;
        files = load(ctx.cwd);
        pinned = true;
        const changed = !sameContextFiles(previous, files);
        const running = !ctx.isIdle();
        if (changed && running) {
          pending = { at: Date.now() };
        }

        showStatus(ctx.hasUI ? ctx.ui : undefined, false);

        if (!changed) {
          notify(formatUnchangedNotice(files.length), "info");
          return;
        }
        notify(formatReloadedNotice(previous, files, ctx.cwd, running), "info");
      },
    });

    pi.on("before_agent_start", (event) => {
      pending = undefined;
      if (pinned) {
        event.systemPromptOptions.contextFiles = files.map((file) => ({ ...file }));
      } else {
        files = event.systemPromptOptions.contextFiles ?? [];
      }
    });

    // Mid-run /rebrief: add a request-local section update until the next run starts
    pi.on("context_with_system", (event) => {
      if (!pending) {
        return;
      }
      const messages = event.messages;
      const desired = renderProjectContext(files);
      if ((getCurrentSystemMessage(messages)?.sections?.project_context ?? null) === desired) {
        return;
      }
      pending.anchor ??= messages.at(-1)?.timestamp;
      const update = { role: "system" as const, content: "", sections: { project_context: desired }, timestamp: pending.at };
      const anchor = messages.findIndex((m) => m.timestamp === pending!.anchor);
      const at = anchor === -1 ? messages.length : anchor + 1;
      return { messages: [...messages.slice(0, at), update, ...messages.slice(at)] };
    });
  };
}

export default createRebriefExtension();
