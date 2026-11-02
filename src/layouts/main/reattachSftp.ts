import type { DetachedSftpParams } from "../../lib/sftpWindowState";
import { useAppStore } from "../../stores/appStore";
import { useSftpStore } from "../../stores/sftpStore";
import type { Tab } from "../../types";

export interface SftpReattachContext {
  tabsRef: { current: Tab[] };
  setActiveTab: (id: string) => void;
  addTab: (tab: Tab) => void;
  showAttachedSftp: (tabId: string) => void;
}

/** Restore the original source without creating another SSH terminal. */
export async function reattachSftp(params: DetachedSftpParams, context: SftpReattachContext) {
  if (!params?.host || !params.parentSessionId) return false;
  const source = context.tabsRef.current.find((tab) =>
    (tab.type === "terminal" && tab.ssh && `attached-${tab.id}` === params.parentSessionId)
    || (tab.type === "sftp" && tab.sftp?.sessionId === params.parentSessionId),
  );
  const app = useAppStore.getState();
  app.setActiveSideTab("sessions");
  if (source) {
    context.setActiveTab(source.id);
    if (source.type === "terminal") {
      app.setTerminalSplitActive(false);
      context.showAttachedSftp(source.id);
    }
    const store = useSftpStore.getState();
    if (store.sessions[params.parentSessionId]?.attached) {
      await Promise.all([
        params.initialPath && store.navigate(params.parentSessionId, "remote", params.initialPath),
        params.initialLocalPath && store.navigate(params.parentSessionId, "local", params.initialLocalPath),
      ]);
    }
  } else {
    // If the SSH tab was closed, retain access to the files in a standalone tab.
    const id = `sftp-reattach-${params.parentSessionId}`;
    context.addTab({
      id, type: "sftp", title: params.title ?? `SFTP — ${params.username}@${params.host}`, closable: true,
      sftp: {
        sessionId: params.parentSessionId, host: params.host, port: params.port,
        username: params.username, authMethod: params.authMethod, authData: params.authData,
        networkSettingsJson: params.networkSettingsJson, initialPath: params.initialPath,
        initialLocalPath: params.initialLocalPath, pathMappings: params.pathMappings,
      },
    });
  }
  return true;
}
