// The archive convention shared by the server command and the TUI sidebar.
// A session is archived when its title starts with this prefix.
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
