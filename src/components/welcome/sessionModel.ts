import { type LocalShellOption, type SessionConfig } from "../../lib/ipc";
import type { LocalShellSelection } from "../../types";
import { type TranslateFn } from "../../lib/i18n";
import { sessionTypeLabel } from "../../lib/terminalProfile";
import { type RecentSessionSort } from "./types";


export function localShellSelectionFromOption(
  shell: LocalShellOption | undefined,
  cwd?: string,
): LocalShellSelection | undefined {
  if (!shell) return undefined;
  const args = shell.args && shell.args.length > 0 ? [...shell.args] : [];
  if (cwd && shell.id.startsWith("wsl:") && !args.includes("--cd")) {
    args.push("--cd", cwd);
  }
  return {
    // Real shells have id === path; virtual WSL entries map id="wsl:<distro>"
    // to path="wsl.exe" — pass the executable path so the backend can resolve it.
    id: shell.path,
    name: shell.name,
    ...(args.length > 0 ? { args } : {}),
  };
}


export function uniqueRecentSessionsById(sessions: readonly SessionConfig[]): SessionConfig[] {
  const seen = new Set<string>();
  const unique: SessionConfig[] = [];
  for (const session of sessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    unique.push(session);
  }
  return unique;
}


export function compareRecentSessions(a: SessionConfig, b: SessionConfig, sort: RecentSessionSort): number {
  const labelA = sessionTypeLabel(a.session_type, a.options_json);
  const labelB = sessionTypeLabel(b.session_type, b.options_json);
  const nameA = (a.name || a.host || labelA).toLowerCase();
  const nameB = (b.name || b.host || labelB).toLowerCase();
  if (sort === "last-asc") return (a.last_connected_at ?? 0) - (b.last_connected_at ?? 0);
  if (sort === "name-asc") return nameA.localeCompare(nameB);
  if (sort === "name-desc") return nameB.localeCompare(nameA);
  if (sort === "type-asc") return labelA.localeCompare(labelB) || nameA.localeCompare(nameB);
  if (sort === "type-desc") return labelB.localeCompare(labelA) || nameA.localeCompare(nameB);
  if (sort === "host-asc") return (a.host || "").localeCompare(b.host || "") || nameA.localeCompare(nameB);
  if (sort === "host-desc") return (b.host || "").localeCompare(a.host || "") || nameA.localeCompare(nameB);
  return (b.last_connected_at ?? 0) - (a.last_connected_at ?? 0);
}


export function recentSessionTarget(session: SessionConfig): string {
  const host = session.host?.trim();
  if (session.session_type === "File") return host || session.name || "File";
  if (session.session_type === "LocalShell") return host || session.name || "Local shell";
  if (!host) return session.group_path || session.session_type;
  const user = session.username ? `${session.username}@` : "";
  const port = session.port ? `:${session.port}` : "";
  return `${user}${host}${port}`;
}


export function formatRecentSessionTime(value: number | null | undefined, t: TranslateFn): string {
  if (!value) return t("welcome.recentSessionsNever");
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value * 1000));
}
