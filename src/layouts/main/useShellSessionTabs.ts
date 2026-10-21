import { useCallback } from "react";
import { openExternalUrl } from "../../lib/sftp";
import type { Tab } from "../../types";
import { type SessionConfig } from "../../lib/ipc";
import { getSessionTerminalProfile, loadTerminalDefaultProfile } from "../../lib/terminalProfile";
import { t as tr } from "../../lib/i18n";
import { browserUrlFromSession, commandTerminalFromSession } from "./sessionPolicy";


export interface UseShellSessionTabsContext {
  setStatusMessage: (message: string) => void;
  markConnected: (id: string) => Promise<void>;
  addTab: (tab: Tab) => void;
}

export function useShellSessionTabs(context: UseShellSessionTabsContext) {
  const { setStatusMessage, markConnected, addTab } = context;

  const openBrowserSession = useCallback((session: SessionConfig) => {
    const url = browserUrlFromSession(session);
    if (!url) {
      setStatusMessage(tr("status.browserSessionMissing"));
      return;
    }
    void openExternalUrl(url).catch((err) => {
      setStatusMessage(tr("status.openFailed", {
        error: err instanceof Error ? err.message : String(err),
      }));
    });
    void markConnected(session.id);
  }, [markConnected, setStatusMessage]);

  const openSshTab = useCallback((session: SessionConfig, authMethod: string, authData: string | null) => {
    const id = `ssh-${session.id}-${Date.now()}`;
    addTab({
      id,
      type: "terminal",
      title: session.name || `${session.username}@${session.host}`,
      sessionId: session.id,
      terminalTitleMode: "pending-auto",
      terminalTitleOperation: "new",
      terminalTitleSessionName: session.name || `${session.username ?? "root"}@${session.host}`,
      closable: true,
      ssh: {
        sessionId: session.id,
        host: session.host,
        port: session.port,
        username: session.username ?? "root",
        authMethod,
        authData,
        optionsJson: session.options_json,
      },
      terminalProfile: getSessionTerminalProfile(session.options_json) ?? loadTerminalDefaultProfile(),
    });
    void markConnected(session.id);
  }, [addTab, markConnected]);

  const openCommandTerminalTab = useCallback((session: SessionConfig) => {
    const commandTerminal = commandTerminalFromSession(session);
    if (!commandTerminal) {
      setStatusMessage(
        session.session_type === "Serial"
          ? tr("status.serialSessionMissing")
          : tr("status.remoteSessionMissing"),
      );
      return;
    }
    const id = `${session.session_type.toLowerCase()}-${session.id}-${Date.now()}`;
    const title = session.name || (
      session.session_type === "Serial"
        ? commandTerminal.host
        : `${session.session_type} ${commandTerminal.username ? `${commandTerminal.username}@` : ""}${commandTerminal.host}`
    );
    addTab({
      id,
      type: "terminal",
      title,
      sessionId: session.id,
      terminalTitleMode: "pending-auto",
      terminalTitleOperation: "new",
      terminalTitleSessionName: session.name || title,
      closable: true,
      commandTerminal,
      terminalProfile: getSessionTerminalProfile(session.options_json) ?? loadTerminalDefaultProfile(),
    });
    void markConnected(session.id);
  }, [addTab, markConnected, setStatusMessage]);

  const openUnsupportedTab = useCallback((session: SessionConfig) => {
    const id = `${session.session_type.toLowerCase()}-${session.id}-${Date.now()}`;
    const kind = ["SFTP", "VNC"].includes(session.session_type)
      ? session.session_type.toLowerCase()
      : "placeholder";
    addTab({
      id,
      type: kind as "sftp" | "vnc" | "placeholder",
      title: session.name || session.host || session.session_type,
      sessionId: session.id,
      closable: true,
      message: `${session.session_type} connection UI is present, but its backend is outside Phase 1-2. Session data is saved and can be edited from the sidebar.`,
    });
  }, [addTab]);
  return { openSshTab, openBrowserSession, openCommandTerminalTab, openUnsupportedTab };
}
