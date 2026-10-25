# pi-rebrief

Adds a `/rebrief` command to [Pi](https://pi.dev) that re-reads your project context
files (`AGENTS.md`, `CLAUDE.md`, …) from disk mid-session so edits reach the agent
without restarting.

## Install

```bash
pi install npm:pi-rebrief
```

Then run `/reload` in an active session, or try it for a single session without installing:

```bash
pi -e npm:pi-rebrief
```

## Usage

Edit your `AGENTS.md` or `CLAUDE.md`, then run:

```
/rebrief
```

`pi-rebrief` reloads the context files from disk immediately, updates the session's
system-prompt context options for the rest of the session, and reports the prompt-cache
impact:

- **When files changed mid-session:** warns how many cached context tokens will be
  invalidated on the next turn (for example, `Reloaded 2 context files. Next turn will invalidate ~48.3k tokens of cached context.`).
- **When nothing changed on disk:** confirms that the context files are unchanged and the
  prompt cache is unaffected.

Pair it with `/tree` to rewind a couple of turns, tighten an instruction in `AGENTS.md`,
run `/rebrief`, and continue from before the derail.

## License

MIT
