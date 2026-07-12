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
    cwd: cwd ?? null,
  };
}
