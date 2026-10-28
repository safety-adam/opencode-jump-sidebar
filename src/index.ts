import { Plugin } from "@opencode/plugin"
import { ARCHIVE_PREFIX } from "./archive.ts"

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
2. Reuse an existing session for that directory if there already is one; otherwise create a session and keep it, so the project comes up with a starter session. Never create a second starter session for the same directory.
3. Reply with one line: \`Created <name>\`.

Do not mention the server, database, project id, session id, or the sidebar.

Name: ${name || "(none supplied — ask the user for a name)"}`
}

function deleteProjectInstructions(args: string): string {
  const target = args.trim()
  return `Delete one OpenCode project: the project named by the supplied argument. Do not ask for confirmation.

1. Find the database path with \`opencode debug paths db\`.
2. Find the single project whose name, folder name, or directory matches the argument. Match the project name first, then the last path segment of its worktree or canonical directory. If no project matches, or more than one does, delete nothing and reply \`No matching project to delete.\`
3. Never delete a project that has sessions. If the matching project has sessions, leave it and ask the user before doing anything with it.
4. Stop the service, delete the project, and start the service again inside a single background job, so the running server cannot write the project back on shutdown and your own session is not interrupted. Using the database path and the project id, delete the project's \`permission\`, \`worktree\`, \`project_directory\`, \`session\`, and \`session_v2\` rows in one transaction:

\`\`\`
nohup zsh -c 'opencode service stop; sleep 2; sqlite3 "<db path>" "<delete transaction>"; sleep 1; opencode service start' >/dev/null 2>&1 &
\`\`\`

5. Reply with one line: \`Deleted <name>\`, using the folder name when the project has no name.

Say "deleted", never "removed from the database". Do not mention the database, backups, caches, locations, sessions counts, or the restart.

Target: ${target || "(none supplied — ask the user which project to delete)"}`
}

function archiveInstructions(args: string): string {
  const target = args.trim()
  return `Archive a session by prepending "${ARCHIVE_PREFIX}" to its title.

1. Run \`opencode session list\` to get session IDs and titles.
2. Find the target session. For the current session, use the most recently updated one that matches this conversation, or ask me to confirm if it is ambiguous. If a target is supplied, match it against the ID or title.
3. If the title already starts with "${ARCHIVE_PREFIX}", say it is already archived and stop.
4. Call the \`set_session_title\` tool with the session's ID, or "self" if it is the current session, and the title "${ARCHIVE_PREFIX}" followed by the existing title.
5. Confirm in one line, referring to the action as archiving. Say "Archived <title>", never "renamed" or "prepended".

Target: ${target || "(none supplied, use the current session)"}`
}

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
        description: "Delete a named OpenCode project that has no sessions",
        execute: ({ sessionID, prompt, delivery }) =>
          ctx.session.prompt({
            sessionID,
            delivery,
            text: deleteProjectInstructions(prompt.text ?? ""),
          }),
      })

      editor.add({
        name: "archive",
        description: "Archive a session. Defaults to the current session",
        execute: ({ sessionID, prompt, delivery }) =>
          ctx.session.prompt({
            sessionID,
            delivery,
            text: archiveInstructions(prompt.text ?? ""),
          }),
      })
    })
  },
})
