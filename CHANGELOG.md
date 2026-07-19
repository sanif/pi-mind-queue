# Changelog

All notable changes to Mind Queue are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-07-19

### Added

- Configure the shortcut that opens and closes Mind Queue through
  `~/.pi/agent/extensions/mind-queue.json`.

## [0.4.0] - 2026-07-18

### Added

- Drop local files or images into the Add screen to save absolute path
  references alongside a thought without copying file contents.
- Work in a larger popup that shows the current project folder, open/done
  counts, clearer modes, highlighted selection, structured sections, and
  easier-to-scan keyboard hints.

## [0.3.0] - 2026-07-17

### Added

- Let the agent list, add, update status, and remove explicitly confirmed Mind
  Queue thoughts without automatic capture or context injection.
- Review open thoughts against Git history and current project features with
  `/mind cleanup`, showing evidence and asking before removing stale entries.

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

[Unreleased]: https://github.com/sanif/pi-mind-queue/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/sanif/pi-mind-queue/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/sanif/pi-mind-queue/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/sanif/pi-mind-queue/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/sanif/pi-mind-queue/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sanif/pi-mind-queue/releases/tag/v0.1.0
