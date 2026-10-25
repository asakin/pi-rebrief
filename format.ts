import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";

type ContextFile = { path: string; content: string };

// Every message starts with this so a user who forgot the extension knows where it comes from
const PREFIX = "pi-rebrief:";

// How many file names to show before falling back to "and N more"
const MAX_LISTED = 3;

// Show a path relative to cwd when inside it or in a parent folder, else home-relative, else absolute
function displayPath(path: string, cwd: string, home: string): string {
  const rel = relative(cwd, path);
  if (rel && !isAbsolute(rel) && (!rel.startsWith("..") || /^(\.\.[/\\])+[^/\\]+$/.test(rel))) {
    return rel;
  }
  if (home && path.startsWith(home + sep)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

interface Changes {
  changed: string[];
  added: string[];
  removed: string[];
}

function diffFiles(previous: readonly ContextFile[], fresh: readonly ContextFile[], cwd: string, home: string): Changes {
  const before = new Map(previous.map((file) => [file.path, file.content]));
  const after = new Set(fresh.map((file) => file.path));
  const changes: Changes = { changed: [], added: [], removed: [] };
  for (const file of fresh) {
    const old = before.get(file.path);
    if (old === undefined) {
      changes.added.push(displayPath(file.path, cwd, home));
    } else if (old !== file.content) {
      changes.changed.push(displayPath(file.path, cwd, home));
    }
  }
  for (const file of previous) {
    if (!after.has(file.path)) {
      changes.removed.push(displayPath(file.path, cwd, home));
    }
  }
  return changes;
}

function fileCount(count: number): string {
  return `${count} file${count === 1 ? "" : "s"}`;
}

// The /rebrief summary: one line per kind of change, capped at MAX_LISTED names
export function describeChanges(
  previous: readonly ContextFile[],
  fresh: readonly ContextFile[],
  cwd: string,
  home: string = homedir(),
): string[] {
  const changes = diffFiles(previous, fresh, cwd, home);
  const lines: string[] = [];
  let remaining = MAX_LISTED;
  for (const kind of ["changed", "added", "removed"] as const) {
    const shown = changes[kind].slice(0, remaining);
    if (shown.length > 0) {
      lines.push(`  ${`${kind}:`.padEnd(8)} ${shown.join(", ")}`);
      remaining -= shown.length;
    }
  }
  const total = changes.changed.length + changes.added.length + changes.removed.length;
  if (total === 0) {
    lines.push("  order changed");
  } else if (total > MAX_LISTED) {
    lines.push(`  and ${total - MAX_LISTED} more`);
  }
  return lines;
}

export function formatReloadedNotice(
  previous: readonly ContextFile[],
  files: readonly ContextFile[],
  cwd: string,
  running: boolean,
): string {
  const when = running
    ? "They apply to the current turn, starting with the agent's next step."
    : "They apply from your next message.";
  return [`${PREFIX} reloaded context files.`, ...describeChanges(previous, files, cwd), when].join("\n");
}

export function formatUnchangedNotice(count: number): string {
  return `${PREFIX} context files are unchanged (${fileCount(count)}). Nothing to reload.`;
}

export function formatDisabledNotice(): string {
  return `${PREFIX} Pi was started with --no-context-files, so there are no context files to reload.`;
}

// Status bar text when the files on disk differ from what the session loaded
export function formatStaleStatus(
  loaded: readonly ContextFile[],
  onDisk: readonly ContextFile[],
  cwd: string,
  home: string = homedir(),
): string {
  const changes = diffFiles(loaded, onDisk, cwd, home);
  const names = [...changes.changed, ...changes.added, ...changes.removed];
  if (names.length === 1) {
    return `● ${PREFIX} ${names[0]} changed on disk since it was loaded. Run /rebrief to load the new version.`;
  }
  const listed = names.slice(0, MAX_LISTED).join(", ");
  const more = names.length > MAX_LISTED ? `, and ${names.length - MAX_LISTED} more` : "";
  const which = names.length > 0 ? ` (${listed}${more})` : "";
  const count = names.length > 0 ? `${names.length} context files` : "context files";
  return `● ${PREFIX} ${count} changed on disk since they were loaded${which}. Run /rebrief to load them.`;
}
