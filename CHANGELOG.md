# Changelog

All notable changes to Mind Queue are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-07-16

### Added

- Capture a thought immediately with `/mind <thought>` while the agent is
  working, without interrupting the active turn or sending the command to the
  model.

## [0.1.0] - 2026-07-15

### Initial release

- Initial public release of Mind Queue for Pi.
- Durable, project-wide thoughts shared across Pi sessions.
- Interactive queue available through `/mind` and `Ctrl+Shift+M`.
- Add, edit, view, complete, remove, and move thoughts back into Pi's editor.
- Single-step undo for the current session's latest queue change.
- Session labels, legacy queue migration, stale-update protection, private file
  permissions, process locking, and atomic writes.

[Unreleased]: https://github.com/sanif/pi-mind-queue/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/sanif/pi-mind-queue/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sanif/pi-mind-queue/releases/tag/v0.1.0
