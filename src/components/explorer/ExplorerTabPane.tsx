import { useEffect, useRef } from "react";
import { basename } from "../../lib/sftp";
import { useAppStore } from "../../stores/appStore";
import { useSftpStore } from "../../stores/sftpStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { ExplorerShell } from "./ExplorerShell";

export interface ExplorerTabPaneProps {
  tabId: string;
  initialPath: string;
  workspaceId?: string;
  active?: boolean;
  onOpenTerminal?: (path: string) => void;
}

/** Keep persisted fallback/title current, but never feed navigation back into
 * attachLocalOnly. The live pane remains the single directory-state owner. */
export function ExplorerTabPane(props: ExplorerTabPaneProps) {
  const { tabId, initialPath, workspaceId, active = true, ...shellProps } = props;
  const startupPath = useRef(initialPath);
  const wasActive = useRef(active);
  const pane = useSftpStore((state) => state.sessions[tabId]?.local);
  useEffect(() => {
    const reactivated = active && !wasActive.current;
    wasActive.current = active;
    if (!reactivated) return;
    const state = useSftpStore.getState();
    const local = state.sessions[tabId]?.local;
    // Initial attach already owns the first listing. An in-flight navigation
    // will publish fresh contents itself, so activation never starts a rival read.
    if (!local?.path || local.loading) return;
    void state.refreshPane(tabId, "local");
  }, [tabId, active]);
  useEffect(() => {
    if (!pane?.path || pane.loading || pane.error) return;
    const path = pane.path;
    if (workspaceId) {
      useWorkspacePlatformStore.getState().updateExplorerPath(workspaceId, tabId, path);
    } else {
      useAppStore.setState((state) => {
        const tab = state.tabs.find((item) => item.id === tabId);
        const title = basename(path) || path;
        if (!tab?.fileBrowser || (tab.fileBrowser.initialPath === path && tab.title === title)) return state;
        return { tabs: state.tabs.map((item) => item.id === tabId
          ? { ...item, title, fileBrowser: { initialPath: path, explorer: true } } : item) };
      });
    }
  }, [tabId, workspaceId, pane?.path, pane?.loading, pane?.error]);
  return <ExplorerShell {...shellProps} tabId={tabId} workspaceId={workspaceId} active={active} initialPath={startupPath.current} />;
}
