import { getAppPlatform } from "../../lib/runtime";
import type { Tab, GitWorkspaceRootInfo } from "../../types";
import { type SessionConfig } from "../../lib/ipc";
import { parseSessionOptions } from "../../lib/terminalProfile";
import type { LocalShellSelection } from "../../types";
import { isChatCapableTabType } from "../../stores/chatStore";
import { gitRepoName } from "../../lib/git";

export const QUICK_CONNECT_VISIBLE_KEY = "taomni.quickConnectVisible";


export function chatBindingIdForTab(tab: Tab | null | undefined): string | null {
  if (!tab || !isChatCapableTabType(tab.type)) return null;
  return tab.chatTabId ?? tab.id;
}


export function macCommandDigitIndex(event: KeyboardEvent): number | null {
  if (
    getAppPlatform() !== "macos" ||
    !event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return null;
  }

  const digit =
    /^[1-9]$/.test(event.key)
      ? event.key
      : event.code.match(/^(?:Digit|Numpad)([1-9])$/)?.[1];
  if (!digit) return null;

  const number = Number.parseInt(digit, 10);
  return number === 9 ? -1 : number - 1;
}


// Whether a local terminal's shell can answer an OSC 7 cwd probe when its tab
// is duplicated. PowerShell and POSIX shells (bash/zsh/git-bash/WSL) can; cmd
// can't emit OSC 7 cleanly, so it's skipped (the duplicate opens in the default
// directory). SSH terminals always run a POSIX remote shell and are handled
// separately. A LocalShellSelection identifies the shell by its executable
// path (see TabBar's shellSelectionFor), so we match on the path/name text.
export function localShellSupportsCwdProbe(localShell?: LocalShellSelection): boolean {
  const hint = `${localShell?.id ?? ""} ${localShell?.name ?? ""}`.toLowerCase();
  if (
    hint.includes("cmd.exe") ||
    hint.includes("command prompt") ||
    hint.includes("command-prompt")
  ) {
    return false;
  }
  return true;
}


export function readQuickConnectVisible(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(QUICK_CONNECT_VISIBLE_KEY) === "true";
  } catch {
    return false;
  }
}


export function writeQuickConnectVisible(visible: boolean) {
  try {
    window.localStorage.setItem(QUICK_CONNECT_VISIBLE_KEY, visible ? "true" : "false");
  } catch {
    // Ignore storage failures; the in-memory visibility state still applies.
  }
}


export function localShellSelectionFromSession(session: SessionConfig): LocalShellSelection | undefined {
  const options = parseSessionOptions(session.options_json);
  const path = typeof options.localShellPath === "string" ? options.localShellPath.trim() : "";
  if (!path) return undefined;
  const args = Array.isArray(options.localShellArgs)
    ? options.localShellArgs.filter((value): value is string => typeof value === "string")
    : undefined;
  return {
    id: path,
    name: session.name || path,
    ...(args && args.length > 0 ? { args } : {}),
  };
}


export function browserUrlFromSession(session: SessionConfig): string | null {
  const target = session.host.trim();
  if (!target) return null;
  if (/^https?:\/\//i.test(target)) return target;
  const withoutSlashes = target.replace(/^\/+/, "");
  const port = session.port > 0 ? `:${session.port}` : "";
  return `https://${withoutSlashes}${port}`;
}


export const COMMAND_TERMINAL_SESSION_TYPES = new Set(["FTP", "Telnet", "Rlogin", "Serial", "Mosh"]);


export function commandTerminalFromSession(session: SessionConfig): NonNullable<Tab["commandTerminal"]> | null {
  if (!COMMAND_TERMINAL_SESSION_TYPES.has(session.session_type)) return null;
  const host = session.host.trim();
  if (!host) return null;
  return {
    sessionId: session.id,
    kind: session.session_type as NonNullable<Tab["commandTerminal"]>["kind"],
    host,
    port: session.port,
    username: session.username,
    optionsJson: session.options_json,
  };
}


export function normalizeGitWorkspaceRoots(roots: readonly GitWorkspaceRootInfo[]): GitWorkspaceRootInfo[] {
  const seen = new Set<string>();
  const next: GitWorkspaceRootInfo[] = [];
  for (const root of roots) {
    const repoRoot = root.repoRoot.trim();
    if (!repoRoot || seen.has(repoRoot)) continue;
    seen.add(repoRoot);
    next.push({
      ...root,
      repoRoot,
      name: root.name || gitRepoName(repoRoot),
      rootIds: root.rootIds ?? [],
    });
  }
  return next.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}


export function gitWorkspaceRootsKey(roots: readonly GitWorkspaceRootInfo[]): string {
  return roots.map((root) => root.repoRoot).sort((a, b) => a.localeCompare(b)).join("\n");
}
