import { useEffect, useRef } from "react";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import { fileKey } from "../codeWorkspaceModel";
import { getAllLeafNodes } from "../recursiveLayoutTree";
import type { WorkspaceHostIntegration } from "../workspaceHostIntegration";

/** Adapt an explicit canvas layout request to the existing editor split owner. */
export function useWorkspaceHostCanvas(host: WorkspaceHostIntegration | undefined, workspaceInstanceId: string, ready: boolean) {
  const lastRequest = useRef<string | null>(null);
  const previousLayout = useRef(host?.canvasLayout ?? "single");
  const request = host ? JSON.stringify({ layout: host.canvasLayout, files: host.paneFiles.map(fileKey) }) : null;
  useEffect(() => {
    if (!host || !ready || !request || lastRequest.current === request) return;
    const store = useCodeWorkspaceStore.getState();
    // Actions synchronously replace Zustand state. Each dependent layout read
    // must use that new state, including the survivor chosen by Unsplit All.
    const currentUi = () => selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    const ui = currentUi();
    const keys = host.paneFiles.map(fileKey);
    if (keys.some((key) => !ui.openFiles[key] || ui.openFiles[key].loading)) return;
    lastRequest.current = request;
    const layoutChanged = previousLayout.current !== host.canvasLayout;
    previousLayout.current = host.canvasLayout;
    // The editor's own Split/Move/Unsplit actions remain independent while the
    // outer canvas is Single. Only an explicit change back from Split collapses.
    if (host.canvasLayout === "single" && !layoutChanged) return;
    store.unsplitAllLayout(workspaceInstanceId);
    if (host.canvasLayout === "single" || keys.length < 2) return;
    const first = getAllLeafNodes(currentUi().layoutTreeV2)[0];
    store.setLeafActiveTab(workspaceInstanceId, first.id, keys[0]);
    store.splitLayoutLeaf(workspaceInstanceId, first.id, "horizontal", keys[1]);
    if (host.canvasLayout === "grid" && keys.length > 2) {
      const pair = getAllLeafNodes(currentUi().layoutTreeV2);
      store.splitLayoutLeaf(workspaceInstanceId, pair[0].id, "vertical", keys[2]);
      if (keys[3]) store.splitLayoutLeaf(workspaceInstanceId, pair[1].id, "vertical", keys[3]);
    }
    const current = currentUi();
    const selected = host.activeFile ? fileKey(host.activeFile) : keys[0];
    const group = Object.values(current.editorGroups).find((candidate) => candidate.activeKey === selected);
    if (group) store.setActiveEditorGroup(workspaceInstanceId, group.id);
  }, [request, ready, workspaceInstanceId, host]);
}
