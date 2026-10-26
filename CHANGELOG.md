# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - unreleased

First public version.

### Added
- FIFO queue shared by all processes of a user, with a configurable concurrency cap
  (`auto` = CPUs / 4), queue position output, per-run timeout and maximum wait.
- Result sharing: identical commands on an identical git working tree (HEAD + tracked changes +
  untracked files) run once; concurrent duplicates wait for and replay the leader's result.
  Successful results are cached for 24 h, failed results for 10 min.
- Self-healing queue: dead owners are detected by pid and heartbeat, their tickets are removed and
  orphaned child processes are terminated; a follower takes over when the leader dies.
- Guard hooks (`szq guard`) and installer (`szq hook install|uninstall|status`) with adapters for
  Claude Code, OpenAI Codex CLI and Cursor, plus an experimental Gemini CLI adapter. The installer
  is idempotent, keeps timestamped backups and refuses to touch files it cannot parse.
- Adapter interface for third-party agents (`--adapter-module`).
- PATH shims (`szq shim`) and a rules block generator (`szq rules`) for agents without hooks.
- Windows support (PATHEXT resolution, `.cmd` shims through `cmd.exe` with argument rejection,
  `taskkill /T`), covered by CI on `windows-latest`.
- English and Korean CLI messages and documentation.
- Benchmarks (`npm run bench`).
