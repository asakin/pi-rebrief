# AGENTS.md — pi-rebrief

## Version control (jj)

This repo uses **Jujutsu (jj)**, colocated with git / GitHub. Agents must use jj for local history — not bare `git commit` / `git add`.

- Prefer `jj describe` / `jj commit` (or the equivalent workflow already in use) for each finished slice.
- Follow-up fixes and review edits are new changes on top of prior ones; do not rewrite history or force-push unless explicitly asked.
- `git` remains present for remotes and tooling; jj is the authoring surface.
- Do not push unless asked.
