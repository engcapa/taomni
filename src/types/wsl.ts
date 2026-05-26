/**
 * WSL-specific options persisted under `SessionConfig.options_json` for
 * `SessionType::LocalShell` sessions whose `localShellPath` is `wsl.exe`.
 *
 * The launch path on disk stays compatible with the legacy auto-import shape
 * (just `localShellPath` + `localShellArgs`), but structured `wsl*` keys are
 * mirrored alongside so the editor can round-trip distro/user/cwd/etc.
 *
 * Argv is composed on the frontend via `buildWslLaunchArgs` and passed
 * through the existing `create_local_terminal` IPC — there is no dedicated
 * WSL backend command.
 */
export interface WslOptions {
  /** Distro name as listed by `wsl.exe -l -v` (e.g. "Ubuntu"). */
  distro: string;
  /** Override the default user (`-u`). */
  user?: string;
  /** Starting directory inside the distro (`--cd`). */
  cwd?: string;
  /** Bootstrap command run before dropping into an interactive login shell. */
  initialCommand?: string;
  /** Persisted but currently inert — admin elevation for saved sessions is wip. */
  asAdministrator?: boolean;
}

export const DEFAULT_WSL_OPTIONS: WslOptions = { distro: "" };

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function deriveDistroFromLocalShellArgs(
  source: Record<string, unknown>,
): string | undefined {
  const path = source.localShellPath;
  const args = source.localShellArgs;
  if (typeof path !== "string") return undefined;
  if (path.split(/[\\/]/).pop()?.toLowerCase() !== "wsl.exe") return undefined;
  if (!Array.isArray(args)) return undefined;
  const idx = args.indexOf("-d");
  if (idx >= 0 && idx + 1 < args.length && typeof args[idx + 1] === "string") {
    return args[idx + 1] as string;
  }
  return undefined;
}

/**
 * Parse `wsl*` keys from a session's `options_json`. Falls back to deriving
 * `distro` from `localShellArgs` for legacy import-shaped sessions.
 */
export function parseWslOptions(optionsJson: string | null | undefined): WslOptions {
  if (!optionsJson) return { ...DEFAULT_WSL_OPTIONS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(optionsJson);
  } catch {
    return { ...DEFAULT_WSL_OPTIONS };
  }
  if (!isStringRecord(parsed)) return { ...DEFAULT_WSL_OPTIONS };

  const distro =
    readString(parsed, "wslDistro") ?? deriveDistroFromLocalShellArgs(parsed) ?? "";

  const out: WslOptions = { distro };
  const user = readString(parsed, "wslUser");
  if (user) out.user = user;
  const cwd = readString(parsed, "wslCwd");
  if (cwd) out.cwd = cwd;
  const initialCommand = readString(parsed, "wslInitialCommand");
  if (initialCommand) out.initialCommand = initialCommand;
  if (parsed.wslAsAdministrator === true) out.asAdministrator = true;
  return out;
}

/**
 * Returns a partial JSON-friendly object the SessionEditor's `buildConfig`
 * spreads over the existing `options_json`. Empty fields are omitted so we
 * don't pollute the saved JSON with empty strings.
 */
export function serializeWslOptions(opts: WslOptions): Record<string, unknown> {
  const out: Record<string, unknown> = { wslDistro: opts.distro };
  if (opts.user) out.wslUser = opts.user;
  if (opts.cwd) out.wslCwd = opts.cwd;
  if (opts.initialCommand) out.wslInitialCommand = opts.initialCommand;
  if (opts.asAdministrator) out.wslAsAdministrator = true;
  return out;
}

/**
 * Compose the argv passed to `wsl.exe`.
 *
 * We use `-- /bin/sh -lc "<cmd>; exec $SHELL -l"` rather than `-e <cmd>`
 * because `-e` runs non-interactively and exits — bad fit for a PTY tab.
 * The trailing `exec $SHELL -l` keeps the shell interactive after the
 * bootstrap completes.
 */
export function buildWslLaunchArgs(opts: WslOptions): string[] {
  const distro = opts.distro?.trim() ?? "";
  if (!distro) return [];
  const args: string[] = ["-d", distro];
  const user = opts.user?.trim();
  if (user) args.push("-u", user);
  const cwd = opts.cwd?.trim();
  if (cwd) args.push("--cd", cwd);
  const initial = opts.initialCommand?.trim();
  if (initial) {
    args.push("--", "/bin/sh", "-lc", `${initial}; exec $SHELL -l`);
  }
  return args;
}
