// The archive convention shared by the server command and the TUI sidebar.
// A session shows as archived in the sidebar when its title starts with this
// prefix. The server archive flag (PATCH /api/session/<id> {"archived":true})
// is what hides it in the app, and the /archive command sets both.
export const ARCHIVE_PREFIX = "[Archived] ";
export function isArchivedTitle(title) {
  return typeof title === "string" && title.startsWith(ARCHIVE_PREFIX);
}
export function toArchivedTitle(title) {
  return isArchivedTitle(title) ? title : ARCHIVE_PREFIX + title;
}
export function toUnarchivedTitle(title) {
  return isArchivedTitle(title) ? title.slice(ARCHIVE_PREFIX.length) : title;
}
