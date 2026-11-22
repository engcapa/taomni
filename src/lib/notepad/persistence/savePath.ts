/**
 * Default Save As location helpers for the Notepad workbench.
 *
 * Save As needs an absolute file path, but the app only knows the last save
 * directory (preference) and `$HOME` (IPC `get_home_dir`). Join them without
 * assuming the host separator: the browser preview's home is a POSIX VFS path
 * (`/preview`) on every host, while a Windows directory must stay
 * `\`-joined. The directory string therefore wins over the platform hint.
 */

export type NotepadSavePlatform = "windows" | "macos" | "linux" | "unknown";

const DRIVE_LETTER = /^[a-z]:/i;
const ROOT_DIRECTORY = /^(?:\/|\\|[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/]?)$/i;
const TRAILING_SEPARATOR = /[\\/]$/;
const TRAILING_SEPARATORS = /[\\/]+$/;

/** Separator implied by the directory spelling, or `null` when it cannot tell. */
function directorySeparator(directory: string, platform: NotepadSavePlatform): "\\" | "/" {
  if (DRIVE_LETTER.test(directory) || directory.includes("\\")) return "\\";
  if (directory.startsWith("/")) return "/";
  return platform === "windows" ? "\\" : "/";
}

/**
 * Trim a configured directory for joining. Filesystem roots (`/`, `C:\`,
 * `\\server\share\`) keep their single trailing separator; every other
 * directory loses trailing separators so a join never doubles them.
 */
function normalizeDirectory(directory: string | null | undefined): string {
  const trimmed = (directory ?? "").trim();
  if (!trimmed) return "";
  if (ROOT_DIRECTORY.test(trimmed)) {
    return TRAILING_SEPARATOR.test(trimmed)
      ? trimmed
      : `${trimmed}${directorySeparator(trimmed, "unknown")}`;
  }
  return trimmed.replace(TRAILING_SEPARATORS, "");
}

/** Spell an already-normalized directory with the separator used for joining. */
function withSeparatorSpelling(directory: string, separator: "\\" | "/"): string {
  return separator === "\\" ? directory.replace(/\//g, "\\") : directory;
}

/**
 * Directory used for a new untitled document's Save As default: the last save
 * directory when one was remembered, otherwise home, otherwise `""` (the
 * dialog then keeps a bare file name).
 */
export function notepadSaveDirectory(
  lastSaveDir: string | null | undefined,
  home: string | null | undefined,
): string {
  return normalizeDirectory(lastSaveDir) || normalizeDirectory(home);
}

/**
 * Join a directory and file name into the absolute default Save As path.
 * An empty directory returns the bare file name; an empty file name returns
 * the directory itself.
 */
export function defaultNotepadSavePath(
  directory: string | null | undefined,
  fileName: string,
  platform: NotepadSavePlatform = "unknown",
): string {
  const dir = normalizeDirectory(directory);
  const name = (fileName ?? "").trim().split(/[\\/]/).pop() ?? "";
  if (!dir) return name;
  if (!name) return dir;
  const separator = directorySeparator(dir, platform);
  const base = withSeparatorSpelling(dir, separator);
  if (TRAILING_SEPARATOR.test(base)) return `${base}${name}`;
  return `${base}${separator}${name}`;
}

/**
 * Directory argument for the native save dialog: it must end with a separator
 * so `saveDialogDefaultPath` (src/lib/ipc/files.ts) treats it as a folder and
 * appends the file name instead of replacing its last segment.
 */
export function notepadDialogDirectory(
  directory: string | null | undefined,
  platform: NotepadSavePlatform = "unknown",
): string {
  const dir = normalizeDirectory(directory);
  if (!dir) return "";
  const separator = directorySeparator(dir, platform);
  const base = withSeparatorSpelling(dir, separator);
  if (TRAILING_SEPARATOR.test(base)) return base;
  return `${base}${separator}`;
}
