# pi-rebrief

![npm](https://img.shields.io/npm/v/pi-rebrief) ![CI](https://github.com/asakin/pi-rebrief/actions/workflows/ci.yml/badge.svg) ![license](https://img.shields.io/npm/l/pi-rebrief) ![Known Vulnerabilities](https://snyk.io/test/github/asakin/pi-rebrief/badge.svg)

A [Pi](https://pi.dev) extension that adds a `/rebrief` command. It reloads the project
context files, including `AGENTS.md` and `CLAUDE.md`, into the running session and tells you
which files have changed.

It also flags in the status bar when those files change on disk, for example after a `git pull`
or a branch switch.

`/reload` refreshes the whole session: settings, extensions, MCP servers, skills, themes, and
context files. `/rebrief` is for when only the context files changed, including while a turn
is in progress.

## Install

```bash
pi install npm:pi-rebrief
```

Restart or `/reload` your session to use.

## Usage

When a context file changes on disk, the status bar says so:

```text
● pi-rebrief: AGENTS.md changed on disk since it was loaded. Run /rebrief to load the new version.
```

Nothing is reloaded until you run:

```text
/rebrief
```

Your next message runs with the new instructions, and so does everything after it. `/rebrief` reports
what it found, for example:

```text
pi-rebrief: reloaded context files.
  changed: AGENTS.md
  added:   sub/AGENTS.md
They apply from your next message.
```

If you run it while a turn is in progress, the rest of that turn will use the new
instructions.

## Examples

- Pair it with `/tree` to retry an earlier prompt under new instructions.
- The agent derails. Rewind with `/tree` to the turn before it did, tighten the instruction
it missed in `AGENTS.md`, run `/rebrief`, and continue from there.
- You `git pull` mid-task and a teammate's commit changed `AGENTS.md`. The status bar flags
it; run `/rebrief` and keep going in the same session.

## License

MIT
