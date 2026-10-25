# pi-rebrief

[![Known Vulnerabilities](https://snyk.io/test/github/asakin/pi-rebrief/badge.svg)](https://snyk.io/test/github/asakin/pi-rebrief)

A [Pi](https://pi.dev) extension that adds a `/rebrief` command. It reloads only the
project context files, including `AGENTS.md` and `CLAUDE.md`, into a running session, and
tells you which files changed. It loads them with the same function Pi uses, so it picks up
whatever files your Pi version discovers.

Pi's own `/reload` also re-reads context files, but along with everything else: settings,
extensions, MCP servers, skills and themes. `/rebrief` leaves all of that running.

## Install

```bash
pi install npm:pi-rebrief
```

Then run `/reload` in an active session, or try it for a single session without installing:

```bash
pi -e npm:pi-rebrief
```

## Usage

Edit a context file, then run:

```
/rebrief
```

Your next message runs with the new instructions, and so does everything after it. `/rebrief` reports
what it found, for example:

- `Reloaded context files: changed AGENTS.md, added sub/AGENTS.md.`
- `Context files unchanged (2 context files).`

If Pi was started with `--no-context-files`, `/rebrief` does nothing.

Pair it with `/tree` to rewind a couple of turns, tighten an instruction in `AGENTS.md`,
run `/rebrief`, and continue from before the derail.

## License

MIT
