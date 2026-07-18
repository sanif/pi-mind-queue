# Mind Queue for Pi

Mind Queue is a project-wide scratchpad for thoughts you do not want to lose while working in [Pi](https://github.com/earendil-works/pi). Thoughts persist across sessions, retain a short creation-session label, and can be moved back into Pi's editor when they become relevant.

**Images and files are supported.** Drop them into the Add screen to save local
`@path` references alongside a thought without copying their contents.

## Install

From npm (latest stable release):

```bash
pi install npm:pi-mind-queue
```

From GitHub (default branch):

```bash
pi install git:github.com/sanif/pi-mind-queue
```

Restart Pi or run `/reload`, then open Mind Queue with `/mind` or `Ctrl+Shift+M`.

If you previously installed a local development copy at `~/.pi/agent/extensions/mind-queue`, remove or rename that directory before installing the package. Loading both copies registers duplicate commands and shortcuts.

## Use

### Available from Pi

| Action | Command |
| --- | --- |
| Toggle Mind Queue | `Ctrl+Shift+M` |
| Open Mind Queue | `/mind` |
| Add while Pi is working | `/mind <thought>` |
| Review stale thoughts | `/mind cleanup` |
| Undo the latest change | `/mind undo` |

### Change the shortcut

Create `~/.pi/agent/extensions/mind-queue.json` and set `shortcut` to any
[Pi key combination](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/keybindings.md):

```json
{
  "shortcut": "ctrl+shift+q"
}
```

Run `/reload` after changing the file. The configured shortcut opens Mind Queue,
closes its overlay, and appears in the overlay hint. `/mind` remains available.

### While Mind Queue is open

These keys are handled only while the Mind Queue overlay is open. They do not
change the normal Pi editor outside the overlay.

| Action | Key |
| --- | --- |
| Add a thought or drop local files/images | `A` |
| Edit in Pi's multiline editor | `E` |
| View the complete thought | `V` |
| Move the thought to Pi's editor | `Enter` |
| Mark open or done | `X` or `Space` |
| Remove | `D` or `Delete` |
| Undo this session's latest change | `U` |
| Move selection | arrow keys or `J`/`K` |
| Close | `Esc` or the configured shortcut |

`/mind <thought>` saves immediately, including while the agent is working.
It does not interrupt the agent or send the command to the model; it only
updates the local project queue.

In the `A` screen, drag local files or images into the terminal to add them as
absolute `@path` references. Mind Queue does not copy or read the dropped file;
the reference stops working if the original file is moved or deleted.

## Agent collaboration

When explicitly asked, the agent can use the `mind_queue` tool to:

- list open, completed, or all thoughts;
- add a thought;
- mark a thought open or done;
- remove a stale thought after you explicitly confirm its ID.

For example: “Show my Mind Queue,” “Save this in my Mind Queue,” or “Mark
thought #3 done.” The tool never captures ordinary conversation or injects the
queue automatically. Agent tool results may contain thought text, making that
text visible to the current model provider. Agent-driven edit and move-to-editor
actions are intentionally unavailable.

`/mind cleanup` starts an agent review of open thoughts against relevant Git
history and current project features. The agent presents likely completed or
stale thoughts with evidence and asks which IDs to remove. Nothing is removed
until you explicitly confirm the specific IDs.

Moving a thought removes it from the queue and inserts it at the current Pi editor cursor. `U` restores both the queue entry and the inserted editor text when the editor has not changed around that insertion.

Mind Queue detects stale dialogs. If another Pi session changes a thought before you edit, remove, move, or toggle it, the stale action is rejected and the queue refreshes instead of overwriting newer work.

## Storage and privacy

Mind Queue stores one JSON file per project under:

```text
<pi-agent-dir>/state/mind-queue/
```

The directory is mode `0700` and files are mode `0600`. Writes use a process lock, a temporary file, `fsync`, and atomic rename. The repository itself is never modified.

Stored data includes:

- thought text and completion state;
- creation time and session ID;
- a session name or a sanitized first-prompt label capped at 46 characters;
- one undo snapshot for the latest change.

Thoughts may contain sensitive information. Back up or remove the state directory according to your own data-retention needs. Uninstalling the package does not delete saved thoughts.

Older session-local Mind Queue snapshots are imported once when a project store is first created. The migration reads Pi's default session catalog and an active custom session directory, if configured.

## Requirements

- Pi with Node.js `>=22.19.0`.
- Interactive TUI mode for the `/mind` overlay and shortcut.
- macOS with `/usr/bin/lockf`, or Linux with `flock` in `/usr/bin`, `/bin`, or `/usr/local/bin`.

Mind Queue fails safely with an actionable error when no supported kernel lock utility is available. Windows is not currently supported.

Pi extensions run with the same system access as Pi. Review extension source before installation.

## Development

```bash
bun install
bun run verify
```

`verify` runs strict TypeScript checks, the complete test suite, and a package dry run. CI runs the same checks on macOS and Linux.

## License

MIT
