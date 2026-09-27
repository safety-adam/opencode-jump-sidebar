# opencode-jump-sidebar

<img width="417" height="340" alt="image" src="https://github.com/user-attachments/assets/e2d2b312-6e48-42b4-a3c1-70db3077b694" />

An OpenCode plugin that adds:

- **Jump to session** — a session sidebar section grouped by project, with per-project collapse, status icons, and a `+` to start a new session in that project.
- **`/new-project`** — create a project (a folder with a starter session).
- **`/delete-project <name>`** — delete the named project when it has no sessions.

Ships both a **server plugin** (the commands, available in every client) and a **CLI/TUI entry** (the sidebar).

## Install

Add it to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": ["opencode-jump-sidebar"]
}
```

The server loads the plugin and registers the commands, and the CLI auto-loads the `./tui` entry, so the sidebar appears without a second step.

The `./tui` entry is a **precompiled** file (`dist/tui.js`). OpenCode only runs its Solid JSX transform on `.tsx` files outside `node_modules`, so a package installed from npm or a git URL must ship compiled JavaScript. See [Troubleshooting](#troubleshooting) and [AGENTS.md](./AGENTS.md).

Local development / sharing from a path:

```jsonc
{
  "plugins": ["./path/to/opencode-jump-sidebar"]
}
```

Or copy the plugin into the global discovery directory, where OpenCode compiles the `.tsx` itself:

```
~/.config/opencode/plugins/opencode-jump-sidebar/index.ts
~/.config/opencode/plugins/opencode-jump-sidebar/tui.tsx
```

The server half imports `@opencode/plugin`, so add it to `~/.config/opencode/package.json` when using discovery:

```json
{
  "dependencies": {
    "@opencode/plugin": "2.0.18"
  }
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
- click `⇣` on a session to archive it, `⇡` to unarchive (same title convention as `/archive`);
- click `·` to mark a session unread (`•`); it clears when you open the session. This is a plugin-local flag stored on this machine — it does not change OpenCode's own unread state or other devices;
- the `≡` toggle shows/hides archived sessions (archived = title starts with `[Archived] `).

- the same panel also appears on the home / new-session screen as a right-hand overlay when the terminal is wide enough (≥120 cols);

Press `Ctrl+X` then `Z` to archive/unarchive the current session (same title convention as the `/archive` command).

## Commands

- `/new-project <name>` — creates `<root>/<name>` (or an explicit path starting with `/` or `~`) and leaves a starter session in it.
- `/delete-project <name>` — deletes the single project matching `<name>` (its name or folder) when that project has no sessions, then restarts the service so the removal sticks. It never deletes a project that has sessions, and it asks which project to delete when no name is supplied.

## Development

The sidebar is written in `src/tui.tsx` and ships to users as `dist/tui.js`.

```sh
npm install
npm run build   # src/tui.tsx -> dist/tui.js
```

`dist/tui.js` is committed and loaded by `exports["./tui"]`. After editing
`src/tui.tsx`, rebuild and commit `dist/tui.js`. `npm run prepack` also builds
it before publishing. See [AGENTS.md](./AGENTS.md) for details.

To try a local checkout without building, copy `index.ts` and `tui.tsx` into
`~/.config/opencode/plugins/opencode-jump-sidebar/` and run
`opencode --standalone` — OpenCode compiles the `.tsx` itself because the file
is outside `node_modules`.

## Troubleshooting

### `Cannot find package 'react' imported from .../src/tui.tsx`

The plugin was installed from npm or a git URL and its TUI entry is a raw `.tsx`.
OpenCode does not run the Solid transform under `node_modules`, so Bun falls back
to the React JSX runtime. Fixes:

- Use a release that ships `dist/tui.js` (see [Development](#development)).
- Or install via the discovery directory shown in [Install](#install), where the
  `.tsx` is transformed correctly.

### The sidebar does not appear

- Make sure the CLI/TUI client was restarted after changing the plugin.
- Run `opencode --standalone --print-logs --log-level debug` and look for
  `stage=setup plugin=jump-sidebar`.
- The home-screen overlay only shows when the terminal is at least 120 columns
  wide.

## License

MIT
