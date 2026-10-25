import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";

type ContextFile = { path: string; content: string };

// Show a path relative to cwd when inside it, else home-relative, else absolute
function displayPath(path: string, cwd: string, home: string): string {
  const rel = relative(cwd, path);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
    return rel;
  }
  if (home && path.startsWith(home + sep)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

// How many files to list in the `/rebrief` notification before it falls back to "and N more"
const MAX_LISTED = 3;

export function describeChanges(
  previous: readonly ContextFile[],
  fresh: readonly ContextFile[],
  cwd: string,
  home: string = homedir(),
): string {
  const before = new Map(previous.map((file) => [file.path, file.content]));
  const after = new Set(fresh.map((file) => file.path));

  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  for (const file of fresh) {
    const old = before.get(file.path);
    if (old === undefined) {
      added.push(displayPath(file.path, cwd, home));
    } else if (old !== file.content) {
      changed.push(displayPath(file.path, cwd, home));
    }
  }
  for (const file of previous) {
    if (!after.has(file.path)) {
      removed.push(displayPath(file.path, cwd, home));
    }
  }

  const total = changed.length + added.length + removed.length;
  if (total === 0) {
    return "order changed";
  }

  // "changed a, b" instead of "changed a, changed b"
  const groups: string[] = [];
  let remaining = MAX_LISTED;
  if (remaining > 0 && changed.length > 0) {
    const shown = changed.slice(0, remaining);
    groups.push(`changed ${shown.join(", ")}`);
    remaining -= shown.length;
  }
  if (remaining > 0 && added.length > 0) {
    const shown = added.slice(0, remaining);
    groups.push(`added ${shown.join(", ")}`);
    remaining -= shown.length;
  }
  if (remaining > 0 && removed.length > 0) {
    const shown = removed.slice(0, remaining);
    groups.push(`removed ${shown.join(", ")}`);
    remaining -= shown.length;
  }

  const more = total - MAX_LISTED;
  if (more > 0) {
    return `${groups.join(", ")}, and ${more} more`;
  }
  return groups.join(", ");
}

function fileCountLabel(count: number): string {
  return `${count} context file${count === 1 ? "" : "s"}`;
}

export function formatUnchangedNotice(count: number): string {
  return `Context files unchanged (${fileCountLabel(count)}).`;
}

export function formatReloadedNotice(
  previous: readonly ContextFile[],
  files: readonly ContextFile[],
  cwd: string,
  running: boolean,
): string {
  const when = running ? " — applies to the running turn" : "";
  return `Reloaded context files: ${describeChanges(previous, files, cwd)}${when}.`;
}
