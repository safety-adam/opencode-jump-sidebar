# opencode-jump-sidebar

<img width="417" height="340" alt="image" src="https://github.com/user-attachments/assets/e2d2b312-6e48-42b4-a3c1-70db3077b694" />

An OpenCode plugin that adds a session sidebar grouped by project, plus two
commands to create and delete projects.

The sidebar is a **Jump to session** section. Each project is a collapsible
group, sessions sort by last updated, and each row carries a status icon. A `+`
next to a project starts a new session in it.

The commands are `/new-project` to create a project, a folder with a starter
session, and `/delete-project <name>` to delete the named project when it has no
sessions.

The package ships a **server plugin** for the commands, available in every
client, and a **CLI/TUI entry** for the sidebar.

## Install

Add it to `~/.config/opencode/opencode.jsonc`.

```jsonc
{
  "plugins": ["opencode-jump-sidebar"]
}
```

The server loads the plugin and registers the commands. The CLI auto-loads the
`./tui` entry, so the sidebar appears without a second step.

The `./tui` entry is a **precompiled** file, `dist/tui.js`. OpenCode only runs
its Solid JSX transform on `.tsx` files outside `node_modules`, so a package
installed from npm or a git URL must ship compiled JavaScript. See
[Troubleshooting](#troubleshooting) and [AGENTS.md](./AGENTS.md).

For local development, or sharing from a path, add a path entry.

```jsonc
{
  "plugins": ["./path/to/opencode-jump-sidebar"]
}
```

Or copy the plugin into the global discovery directory, where OpenCode compiles
the `.tsx` itself.

```
~/.config/opencode/plugins/opencode-jump-sidebar/index.ts
~/.config/opencode/plugins/opencode-jump-sidebar/tui.tsx
```

The server half imports `@opencode/plugin`, so add it to
`~/.config/opencode/package.json` when using discovery.

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

The session sidebar gets a **Jump to session** section.

- one collapsible group per project, sorted alphabetically;
- sessions within a project sorted by last updated;
- a status icon per session. An orange spinner means working, `!` a pending permission, `?` a pending question, `•` unread;
- click a session to open it, `+` next to a project to create a session in it;
- click `+` on the **Jump to session** heading to create a new project. A prompt asks for the name, then it creates the folder under the configured `root` and a seeded session, the same result as `/new-project`;
- click `⇣` on a session to archive it, `⇡` to unarchive, the same title convention as `/archive`;
- click `·` to mark a session unread (`•`). It clears when you open the session. This is a plugin-local flag stored on this machine, so it does not change OpenCode's own unread state or other devices;
- the `≡` toggle shows or hides archived sessions. A session is archived when its title starts with `[Archived] `;
- the same panel appears on the home and new-session screen as a right-hand overlay when the terminal is at least 120 columns wide.

Press `Ctrl+X` then `Z` to archive or unarchive the current session, the same
title convention as the `/archive` command.

## Session decorations

Other TUI plugins can annotate session rows without importing anything from this
one. A plugin writes one JSON file into a shared directory, and the sidebar
merges every file and draws a dot before the session title and a label after it.

| Thing | Value |
| --- | --- |
| Directory | `~/.local/share/opencode/sidebar/decorations/` |
| Override | set `OPENCODE_SIDEBAR_DIR` to move the parent directory |
| File | `<plugin-id>.json`, one per contributing plugin |
| Shape | `{ "sessions": { "<sessionID>": { "dot": { "color": "red", "title": "Recording" }, "label": "REC" } } }` |

`color` is any OpenTUI colour, a name or a hex string. `title` is a tooltip.
`label` is short text shown after the dot. A plugin removes its file to clear
its decorations. The opencode-transcript plugin uses this to show a red dot on
the session that is recording.

## Commands

- `/new-project <name>` creates `<root>/<name>`, or an explicit path starting with `/` or `~`, and leaves a starter session in it.
- `/delete-project <name>` deletes the single project matching `<name>`, its name or folder, when that project has no sessions, then restarts the service so the removal sticks. It never deletes a project that has sessions, and it asks which project to delete when no name is supplied.

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
`opencode --standalone`. OpenCode compiles the `.tsx` itself because the file is
outside `node_modules`.

## Troubleshooting

### `Cannot find package 'react' imported from .../src/tui.tsx`

The plugin was installed from npm or a git URL and its TUI entry is a raw `.tsx`.
OpenCode does not run the Solid transform under `node_modules`, so Bun falls back
to the React JSX runtime. Two fixes.

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
