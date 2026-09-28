# AGENTS.md

Guidance for agents and contributors working on this plugin.

## What this package is

An OpenCode plugin with two halves that ship together:

| File | Half | Loaded by |
| --- | --- | --- |
| `src/index.ts` | Server (the `/new-project` and `/delete-project` commands) | the OpenCode server |
| `src/tui.tsx` | CLI/TUI (the "Jump to session" sidebar) | the OpenCode terminal client |

`src/tui.tsx` contains JSX and must be compiled before it is published. The
compiled artifact, `dist/tui.js`, is committed to this repository and is what
`exports["./tui"]` points at.

## Critical constraint: `.tsx` under `node_modules`

OpenCode only runs its Solid JSX transform on `.tsx` files **outside**
`node_modules`. A plugin installed from npm or a git URL is unpacked under
`node_modules`, so a raw `.tsx` TUI entry is handed to Bun's default JSX
transform, which emits `import ... from "react"` — a package that is not
installed. The plugin then fails with:

```
Cannot find package 'react' imported from .../node_modules/opencode-jump-sidebar/src/tui.tsx
```

This is why the TUI entry must be precompiled:

- **Never** set `exports["./tui"]` to `./src/tui.tsx`.
- `exports["./tui"]` must be `./dist/tui.js`.
- After editing `src/tui.tsx`, run `npm run build` and commit the updated
  `dist/tui.js`. `npm run prepack` does this automatically before publishing.

The compiled output imports the Solid runtime primitives from `@opentui/solid`
(plus `@opencode/plugin/tui` and `solid-js`). OpenCode bridges all of those at
runtime, so the output works from `node_modules` and from a local path.

## Build

```sh
npm install
npm run build      # src/tui.tsx -> dist/tui.js
```

`scripts/build-tui.mjs` compiles the TUI with Babel (`@babel/preset-typescript`
+ `babel-preset-solid`, `generate: "universal"`, `moduleName: "@opentui/solid"`),
which matches how OpenCode transforms its own first-party TUI plugins.

`src/index.ts` is plain TypeScript with no JSX and is shipped as source; OpenCode
loads it directly on the server.

## Testing locally

Fastest loop (no install, uses discovery — see below):

1. Copy `index.ts` and `tui.tsx` (or `dist/tui.js`) into
   `~/.config/opencode/plugins/opencode-jump-sidebar/`.
2. Run the TUI in a private server to avoid disturbing a running instance:
   ```sh
   opencode --standalone --print-logs --log-level debug
   ```
3. Look for `stage=setup plugin=jump-sidebar` and the "Jump to session" panel.
   A `Cannot find package 'react'` error means a `.tsx` is being loaded from
   `node_modules` instead of `dist/tui.js`.

To test the packaged install path, pack and install it:

```sh
npm pack
opencode plugin add ./opencode-jump-sidebar-1.0.0.tgz
```

## Install methods

- **Published / git (recommended for users):** add the package to `plugins` in
  `~/.config/opencode/opencode.json(c)`. The committed `dist/tui.js` is loaded.
- **Local development via discovery:** copy the plugin into
  `~/.config/opencode/plugins/opencode-jump-sidebar/` as `index.ts` and `tui.tsx`.
  Files here are outside `node_modules`, so OpenCode's own transform handles the
  `.tsx`. For any plugin whose server half imports `@opencode/plugin`, add
  `"@opencode/plugin": "2.0.18"` (or the version matching the user's OpenCode)
  to `~/.config/opencode/package.json` so the server can resolve it.

## References

- Plugins: <https://opencode.ai/v2/docs/build/plugins>
- CLI/TUI plugins: <https://opencode.ai/v2/docs/build/plugins/cli>
- Loading and discovery: <https://opencode.ai/v2/docs/cli/plugins>
