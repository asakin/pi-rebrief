import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
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
}

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

// Create the rebrief extension
export function createRebriefExtension(deps: RebriefDeps = {}) {
  const resolveAgentDir = deps.getAgentDir ?? getAgentDir;
  const loadContextFiles = deps.loadProjectContextFiles ?? loadProjectContextFiles;
  const contextFilesDisabled = deps.contextFilesDisabled ?? (() => contextFilesDisabledByArgv(process.argv));

  return function piRebrief(pi: ExtensionAPI) {
    let rebriefed: { cwd: string; files: ContextFile[] } | undefined;

    pi.on("session_start", () => {
      rebriefed = undefined;
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

        const baseOptions = ctx.getSystemPromptOptions?.();
        const previousFiles =
          rebriefed?.cwd === ctx.cwd
            ? rebriefed.files
            : (baseOptions?.contextFiles ?? []);
        const changed = !sameContextFiles(previousFiles, freshFiles);

        rebriefed = { cwd: ctx.cwd, files: cloneContextFiles(freshFiles) };
        if (baseOptions) {
          baseOptions.contextFiles = cloneContextFiles(freshFiles);
        }

        if (!ctx.hasUI) return;

        if (!changed) {
          ctx.ui.notify(`Context files unchanged (${fileCountLabel(freshFiles.length)}).`, "info");
          return;
        }

        ctx.ui.notify(`Reloaded context files: ${describeChanges(previousFiles, freshFiles, ctx.cwd)}.`, "info");
      },
    });

    pi.on("before_agent_start", async (event) => {
      if (!rebriefed || rebriefed.cwd !== event.systemPromptOptions.cwd) return;
      event.systemPromptOptions.contextFiles = cloneContextFiles(rebriefed.files);
    });
  };
}

export default createRebriefExtension();
