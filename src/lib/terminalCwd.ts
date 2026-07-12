import type { AppPlatform } from "./runtime";

/**
 * Normalize a working directory captured from a terminal's OSC 7 report into a
 * path the backend can hand to a freshly launched LOCAL shell as its start
 * directory. Returns `null` when the report can't be turned into a usable
 * start directory on this platform, so callers fall back to the default cwd
 * instead of risking a failed shell spawn.
 *
 * OSC 7 surfaces directories as `file://host/<path>`, and `parseOsc7` returns
 * the `<path>` part with a leading slash. On Windows that yields shapes the OS
 * won't accept verbatim as a working directory:
 *   - PowerShell reports Windows paths, so the URI path looks like
 *     `/D:/code/app` — the slash before the drive letter must go.
 *   - Git Bash / MSYS report `/d/code/app` — the drive must be reconstructed.
 *   - MSYS/WSL paths with no drive (`/home/user`, `/usr`) have no Windows
 *     equivalent we can pass to CreateProcess, so they return `null`.
 * On non-Windows platforms the reported path is already a native absolute path
 * and is returned unchanged.
 *
 * Only ever apply this to LOCAL terminals: an SSH terminal's cwd is a remote
 * path consumed by a remote `cd`, never by the local OS.
 */
export function normalizeLocalStartCwd(cwd: string, platform: AppPlatform): string | null {
  if (!cwd) return null;
  if (platform !== "windows") return cwd;

  // Native Windows paths are already valid for CreateProcess cwd. This path
  // shape comes from local directory shortcuts rather than OSC 7 reports.
  if (/^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith("\\\\")) return cwd;

  // `/D:/code/app` (PowerShell / cmd via OSC 7) → `D:\code\app`.
  const drive = /^\/([A-Za-z]:)(.*)$/.exec(cwd);
  if (drive) {
    return (drive[1] + drive[2]).replace(/\//g, "\\");
  }
  // `/d` or `/d/rest` (MSYS / Git Bash drive path) → `D:\` / `D:\rest`.
  const msys = /^\/([A-Za-z])(\/.*)?$/.exec(cwd);
  if (msys) {
    return `${msys[1].toUpperCase()}:${msys[2] ?? "/"}`.replace(/\//g, "\\");
  }
  // No Windows drive to anchor to (MSYS `/home`, WSL Linux paths, …).
  return null;
}

/**
 * Return the compact directory label used as a terminal tab title prefix.
 * OSC 7 paths can use either POSIX or Windows separators (WSL/MSYS included),
 * so this intentionally does not depend on the frontend host platform.
 */
export function terminalCwdTitlePrefix(cwd: string): string | null {
  const value = cwd.trim();
  if (!value) return null;

  const withoutTrailingSeparators = value.replace(/[\\/]+$/g, "");
  if (!withoutTrailingSeparators) return "root";

  // Native or OSC-normalized Windows drive roots: `C:\\`, `C:/`, `/C:/`.
  const driveRoot = /^\/?([A-Za-z]):$/.exec(withoutTrailingSeparators);
  if (driveRoot) return driveRoot[1].toUpperCase();

  const segments = withoutTrailingSeparators.split(/[\\/]+/).filter(Boolean);
  const last = segments.at(-1)?.trim();
  return last || null;
}
