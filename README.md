# opencode-jump-sidebar

<img width="417" height="340" alt="image" src="https://github.com/user-attachments/assets/e2d2b312-6e48-42b4-a3c1-70db3077b694" />

An OpenCode plugin that adds:

- **Jump to session** — a session sidebar section grouped by project, with per-project collapse, status icons, and a `+` to start a new session in that project.
- **`/new-project`** — create a project (a folder with a starter session).
- **`/delete-project`** — remove projects that have no sessions.

Ships both a **server plugin** (the commands, available in every client) and a **CLI/TUI entry** (the sidebar).

## Install

Add it to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": ["opencode-jump-sidebar"]
}
```

The server loads the plugin and registers the commands, and the CLI auto-loads the `./tui` entry, so the sidebar appears without a second step.

Local development / sharing from a path:

```jsonc
{
  "plugins": ["./path/to/opencode-jump-sidebar"]
}
```

## Options

| Option | Default | Description |
| --- | --- | --- |
| `root` | `~/OpenCode projects` | Directory that `/new-project <name>` creates folders under. |

```jsonc
{
  "plugins": [
    { "package": "opencode-jump-sidebar", "options": { "root": "~/Work/Projects" } }
  ]
}
```

## Jump to session

The session sidebar gets a **Jump to session** section:

- one collapsible group per project, sorted alphabetically;
- sessions within a project sorted by last updated;
- status icon per session — orange spinner while working, `!` for a pending permission, `?` for a pending question, `•` for unread;
- click a session to open it, `+` next to a project to create a session in it;
- the `≡` toggle shows/hides archived sessions (archived = title starts with `[Archived] `).

Press `Ctrl+X` then `Z` to archive/unarchive the current session (same title convention as the `/archive` command).

## Commands

- `/new-project <name>` — creates `<root>/<name>` (or an explicit path starting with `/` or `~`) and leaves a starter session in it.
- `/delete-project` — removes every project with no sessions and restarts the service so the removal sticks.

## License

MIT
