# Changelog

All notable changes to this project are documented in this file.

## [0.1.2] - 2026-10-25

- Anchor mid-turn `/rebrief` context updates after the last message when multiple messages share a millisecond timestamp (such as parallel `toolResult` batches), instead of inserting the update between them.

## [0.1.1] - 2026-10-25

- Expand the npm package description for the Pi package catalogue.
- Override `undici` in dev dependencies to resolve a transitive security advisory.

## [0.1.0] - 2026-10-25

- `/rebrief` command to reload project context files (`AGENTS.md`, `CLAUDE.md`) into a running Pi session without restarting extensions, skills, themes, or MCP servers, reporting which files changed, were added, or were removed.
- Apply `/rebrief` mid-turn when run while the agent is working, and show a status bar warning when context files change on disk.
- Honor `--no-context-files` (`-nc`).

[0.1.2]: https://github.com/asakin/pi-rebrief/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/asakin/pi-rebrief/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/asakin/pi-rebrief/releases/tag/v0.1.0
