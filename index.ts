import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";

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

// Format the number of tokens into a human-readable string
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${m >= 10 ? Math.round(m) : Number(m.toFixed(1))}M tokens`;
  }
  if (tokens >= 1_000) {
    const k = tokens / 1_000;
    return `${k >= 100 ? Math.round(k) : Number(k.toFixed(1))}k tokens`;
  }
  return `${tokens} token${tokens === 1 ? "" : "s"}`;
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
      description: "Re-read project context files (AGENTS.md, CLAUDE.md, etc.) into the system prompt",
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
          ctx.ui.notify(
            `Context files unchanged (${fileCountLabel(freshFiles.length)}) — prompt cache unaffected.`,
            "info",
          );
          return;
        }

        const tokens = ctx.getContextUsage?.()?.tokens;
        if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) {
          ctx.ui.notify(
            `Reloaded ${fileCountLabel(freshFiles.length)}. Next turn will invalidate ~${formatTokens(tokens)} of cached context.`,
            "warning",
          );
          return;
        }

        ctx.ui.notify(`Reloaded ${fileCountLabel(freshFiles.length)} for the next turn.`, "info");
      },
    });

    pi.on("before_agent_start", async (event) => {
      if (!rebriefed || rebriefed.cwd !== event.systemPromptOptions.cwd) return;
      event.systemPromptOptions.contextFiles = cloneContextFiles(rebriefed.files);
    });
  };
}

export default createRebriefExtension();
