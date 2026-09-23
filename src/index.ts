import { Plugin } from "@opencode/plugin"

/**
 * Default directory new projects are created under. Override with the plugin
 * option `root`, e.g.:
 *
 *   { "plugins": [{ "package": "opencode-jump-sidebar", "options": { "root": "~/Work/Projects" } }] }
 */
const DEFAULT_ROOT = "~/OpenCode projects"

function newProjectInstructions(root: string, args: string): string {
  const name = args.trim()
  return `Create an OpenCode project for the supplied name. If the value starts with \`/\` or \`~\`, treat it as an explicit path; otherwise create \`<root>/<name>\` under:

\`\`\`
${root}
\`\`\`

Quote the real path; never use backslash-escaped paths.

1. \`mkdir -p\` the directory.
2. Create a session in that directory and keep it, so the project comes up with a starter session.
3. Reply with one line: \`Created <name>\`.

Do not mention the server, database, project id, session id, or the sidebar.

Name: ${name || "(none supplied — ask the user for a name)"}`
}

const DELETE_PROJECT_INSTRUCTIONS = `Remove every OpenCode project that has no sessions. Do not ask for confirmation.

1. Find the database path with \`opencode debug paths db\`.
2. Delete every project with no sessions, in one transaction, along with its \`session_v2\`, \`session\`, and \`project_directory\` rows.
3. Restart the service in the background so the removal is not undone:

\`\`\`
nohup zsh -c 'sleep 5; opencode service restart' >/dev/null 2>&1 &
\`\`\`

4. Reply with one line per project: \`Deleted <name>\`, using the folder name when the project has no name. If there is nothing to delete, reply \`No empty projects to delete.\`

Never delete a project that has sessions. If a project has sessions, leave it and ask the user before doing anything with it.

Say "deleted", never "removed from the database". Do not mention the database, backups, caches, locations, sessions counts, or the restart.`

export default Plugin.define({
  id: "opencode.jump-sidebar",
  async setup(ctx) {
    const root = typeof ctx.options.root === "string" && ctx.options.root ? ctx.options.root : DEFAULT_ROOT

    await ctx.command.transform((editor) => {
      editor.add({
        name: "new-project",
        description: "Create an OpenCode project with a starter session",
        execute: ({ sessionID, prompt, delivery }) =>
          ctx.session.prompt({
            sessionID,
            delivery,
            text: newProjectInstructions(root, prompt.text ?? ""),
          }),
      })

      editor.add({
        name: "delete-project",
        description: "Remove OpenCode projects that have no sessions",
        execute: ({ sessionID, prompt, delivery }) =>
          ctx.session.prompt({
            sessionID,
            delivery,
            text: DELETE_PROJECT_INSTRUCTIONS,
          }),
      })
    })
  },
})
