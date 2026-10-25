# pi-rebrief

[![Known Vulnerabilities](https://snyk.io/test/github/asakin/pi-rebrief/badge.svg)](https://snyk.io/test/github/asakin/pi-rebrief)

A [Pi](https://pi.dev) extension that adds a `/rebrief` command. It reloads only the
project context files, including `AGENTS.md` and `CLAUDE.md`, into a running session, and
tells you which files changed. It also warns you in the status bar when those files change
on disk, for example after a `git pull` or a branch switch. It loads them with the same
function Pi uses, so it picks up whatever files your Pi version discovers.

Pi's own `/reload` also re-reads context files, but along with everything else: settings,
extensions, MCP servers, skills and themes, and it refuses to run while the agent is working.
`/rebrief` leaves all of that running, and works mid-run.

## Install

```bash
pi install npm:pi-rebrief
```

Then run `/reload` in an active session, or try it for a single session without installing:

```bash
pi -e npm:pi-rebrief
```

## Usage

When a context file changes on disk, the status bar shows
`● context files changed — /rebrief`. Nothing is reloaded until you run:

```text
/rebrief
```

Your next message runs with the new instructions, and so does everything after it. `/rebrief` reports
what it found, for example:

- `Reloaded context files: changed AGENTS.md, added sub/AGENTS.md.`
- `Context files unchanged (2 context files).`

Run it while the agent is working and the change applies to the running turn: the agent's
next model request already has the new instructions
(`Reloaded context files: changed AGENTS.md — applies to the running turn.`). An extension
that replaces the whole system prompt for a run blocks this; the change then applies at your
next message.

If Pi was started with `--no-context-files`, `/rebrief` does nothing and nothing is watched.

Pair it with `/tree` to rewind a couple of turns, tighten an instruction in `AGENTS.md`,
run `/rebrief`, and continue from before the derail.

## License

MIT
