import type { SessionConfig } from "./ipc";
import { tabHost } from "./tabFilter";
import type { Tab } from "../types";
import type { TerminalRuntimeInfo } from "../stores/appStore";

type Translate = (key: string, args?: Record<string, string | number>) => string;

export interface TabDetailSummary {
  sessionLabel: string;
  connectionLabel: string;
  endpoint: string | null;
  activityLabel: string;
  activityState: TerminalRuntimeInfo["state"] | null;
  program: string | null;
  cwd: string | null;
}

function endpointForTab(tab: Tab, session?: SessionConfig): string {
  const host = session?.host || tabHost(tab);
  if (!host) return "";
  const port = session?.port ?? tab.ssh?.port ?? tab.commandTerminal?.port;
  const username = session?.username ?? tab.ssh?.username ?? tab.commandTerminal?.username;
  const authority = `${username ? `${username}@` : ""}${host}`;
  return port && port > 0 ? `${authority}:${port}` : authority;
}

function typeLabel(tab: Tab, session: SessionConfig | undefined, t: Translate): string {
  if (tab.type === "terminal") {
    if (tab.ssh) return t("tabs.detailsRemote");
    if (tab.commandTerminal) {
      return tab.commandTerminal.kind === "Serial"
        ? tab.commandTerminal.kind
        : t("tabs.detailsRemote");
    }
    return t("tabs.detailsLocal");
  }
  return session?.session_type || tab.type;
}

export function buildTabDetailSummary(
  tab: Tab,
  sessions: readonly SessionConfig[],
  runtime: TerminalRuntimeInfo | undefined,
  cwd: string | undefined,
  t: Translate,
): TabDetailSummary {
  const session = tab.sessionId ? sessions.find((item) => item.id === tab.sessionId) : undefined;
  const endpoint = endpointForTab(tab, session);
  let sessionLabel: string;

  if (session) {
    sessionLabel = session.name || endpoint || session.session_type;
  } else if (tab.type === "terminal" && !tab.ssh && !tab.commandTerminal) {
    sessionLabel = t("tabs.detailsTemporaryLocal");
  } else if (endpoint) {
    sessionLabel = t("tabs.detailsAdHocSession");
  } else {
    sessionLabel = t("tabs.detailsNoSession");
  }

  const kind = typeLabel(tab, session, t);

  if (tab.type !== "terminal") {
    return {
      sessionLabel,
      connectionLabel: kind,
      endpoint: endpoint || null,
      activityLabel: t("tabs.detailsTabType", { type: kind }),
      activityState: null,
      program: null,
      cwd: null,
    };
  }

  const state = runtime?.state ?? "unknown";
  let activityLabel: string;
  if (state === "running") {
    activityLabel = runtime?.program
      ? t("tabs.detailsRunningProgram", { program: runtime.program })
      : t("tabs.detailsRunningUnknown");
  } else if (state === "idle") {
    const shell = tab.localShell?.name || (tab.ssh ? t("tabs.detailsRemoteShell") : t("tabs.detailsShell"));
    activityLabel = t("tabs.detailsIdle", { shell });
  } else {
    activityLabel = t(`tabs.detailsState${state[0].toUpperCase()}${state.slice(1)}`);
  }

  return {
    sessionLabel,
    connectionLabel: kind,
    endpoint: endpoint || null,
    activityLabel,
    activityState: state,
    program: state === "running" ? runtime?.program ?? null : null,
    cwd: cwd ?? null,
  };
}

/**
 * Format the hover-card summary plus extra identifiers into a multi-line
 * clipboard payload. Field labels stay English so the text is easy to paste
 * into tickets / chat regardless of UI language.
 */
export function formatTabSessionInfo(
  tab: Tab,
  sessions: readonly SessionConfig[],
  runtime: TerminalRuntimeInfo | undefined,
  cwd: string | undefined,
  t: Translate,
): string {
  const summary = buildTabDetailSummary(tab, sessions, runtime, cwd, t);
  const session = tab.sessionId ? sessions.find((item) => item.id === tab.sessionId) : undefined;
  const host = session?.host || tab.ssh?.host || tab.commandTerminal?.host || tab.sftp?.host
    || tab.vnc?.host || tab.rdp?.host || tab.db?.host || null;
  const port = session?.port ?? tab.ssh?.port ?? tab.commandTerminal?.port ?? tab.sftp?.port
    ?? tab.vnc?.port ?? tab.rdp?.port ?? tab.db?.port ?? null;
  const username = session?.username ?? tab.ssh?.username ?? tab.commandTerminal?.username
    ?? tab.sftp?.username ?? tab.vnc?.username ?? tab.rdp?.username ?? tab.db?.username ?? null;

  const lines: string[] = [
    `Title: ${tab.title}`,
    `Type: ${tab.type}`,
    `Connection: ${summary.connectionLabel}`,
    `Session: ${summary.sessionLabel}`,
  ];

  if (summary.endpoint) lines.push(`Endpoint: ${summary.endpoint}`);
  if (host) lines.push(`Host: ${host}`);
  if (port != null && port > 0) lines.push(`Port: ${port}`);
  if (username) lines.push(`Username: ${username}`);
  if (session?.group_path) lines.push(`Group: ${session.group_path}`);
  if (session?.session_type) lines.push(`Session type: ${session.session_type}`);

  if (tab.type === "terminal") {
    lines.push(`CWD: ${summary.cwd ?? t("tabs.detailsCwdUnknown")}`);
    lines.push(`Activity: ${summary.activityLabel}`);
    if (summary.activityState) lines.push(`State: ${summary.activityState}`);
    if (summary.program) lines.push(`Program: ${summary.program}`);
    if (runtime?.activitySource) lines.push(`Activity source: ${runtime.activitySource}`);
    if (tab.localShell?.name) lines.push(`Shell: ${tab.localShell.name}`);
    if (tab.commandTerminal?.kind) lines.push(`Protocol: ${tab.commandTerminal.kind}`);
  } else {
    lines.push(`Activity: ${summary.activityLabel}`);
  }

  lines.push(`Tab ID: ${tab.id}`);
  if (tab.sessionId) lines.push(`Session ID: ${tab.sessionId}`);
  if (tab.connectionId) lines.push(`Connection ID: ${tab.connectionId}`);
  if (runtime?.backendSessionId) lines.push(`Backend session: ${runtime.backendSessionId}`);
  if (tab.chatTabId && tab.chatTabId !== tab.id) lines.push(`Chat tab ID: ${tab.chatTabId}`);

  return lines.join("\n");
}
