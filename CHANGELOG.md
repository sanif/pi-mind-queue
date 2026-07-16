# Changelog

All notable changes to Mind Queue are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-07-16

### Added

- Capture a thought immediately with `/mind <thought>`, including while the
  agent is working.
- Package-level coverage that verifies direct command capture after install.

### Changed

- Clarified that direct capture updates only the local project queue and does
  not interrupt the agent or send the command to the model.
- Changed the recommended npm and Git install commands to omit version suffixes;
  npm resolves its `latest` stable dist-tag and Git follows the default branch.

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
