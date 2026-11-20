import { useEffect, useRef } from "react";
import { basename } from "../../lib/sftp";
import { useExplorerStore } from "../../stores/explorerStore";
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
      useExplorerStore.getState().updateExplorerPath(tabId, path, basename(path) || path);
    }
  }, [tabId, workspaceId, pane?.path, pane?.loading, pane?.error]);
  return <ExplorerShell {...shellProps} tabId={tabId} workspaceId={workspaceId} active={active} initialPath={startupPath.current} />;
}
