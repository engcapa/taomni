import { type Orientation } from "./types";

export const ORIENTATION_KEY_PREFIX = "taomni.sftp.orientation.";

export function remotePathForTerminalCwd(cwd: string, homeDir: string | null | undefined): string {
  if (!homeDir || !/^\/?[A-Za-z]:\//.test(homeDir)) return cwd;
  return cwd.replace(/^\/([A-Za-z])(?=\/|$)/, (_match, drive: string) => `/${drive.toUpperCase()}:`);
}

export function terminalPathForRemotePath(path: string, homeDir: string | null | undefined): string {
  if (!homeDir || !/^\/?[A-Za-z]:\//.test(homeDir)) return path;
  return path.replace(/^\/([A-Za-z]):(?:\/|$)/, "$1:/");
}

export function loadOrientation(scope: string, fallback: Orientation): Orientation {
  try {
    const v = localStorage.getItem(ORIENTATION_KEY_PREFIX + scope);
    return v === "horizontal" || v === "vertical" ? v : fallback;
  } catch {
    return fallback;
  }
}

export function saveOrientation(scope: string, value: Orientation): void {
  try {
    localStorage.setItem(ORIENTATION_KEY_PREFIX + scope, value);
  } catch {
    /* noop */
  }
}
