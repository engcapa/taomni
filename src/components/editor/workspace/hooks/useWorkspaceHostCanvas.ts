import { useCallback, useEffect, useRef } from "react";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import { fileKey } from "../codeWorkspaceModel";
import { getAllLeafNodes } from "../recursiveLayoutTree";
import type { WorkspaceHostIntegration } from "../workspaceHostIntegration";

/** Adapt an explicit canvas layout request to the existing editor split owner. */
export function useWorkspaceHostCanvas(host: WorkspaceHostIntegration | undefined, workspaceInstanceId: string, ready: boolean) {
  const lastRequest = useRef<string | null>(null);
  const previousLayout = useRef(host?.canvasLayout ?? "single");
  const reconcile = useCallback((requested: WorkspaceHostIntegration) => {
    const request = JSON.stringify({ layout: requested.canvasLayout, files: requested.paneFiles.map(fileKey) });
    if (lastRequest.current === request) return;
    const store = useCodeWorkspaceStore.getState();
    // Actions synchronously replace Zustand state. Each dependent layout read
    // must use that new state, including the survivor chosen by Unsplit All.
    const currentUi = () => selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    const ui = currentUi();
    const keys = requested.paneFiles.map(fileKey);
    if (keys.some((key) => !ui.openFiles[key] || ui.openFiles[key].loading)) return;
    lastRequest.current = request;
    const layoutChanged = previousLayout.current !== requested.canvasLayout;
    previousLayout.current = requested.canvasLayout;
    // The editor's own Split/Move/Unsplit actions remain independent while the
    // outer canvas is Single. Only an explicit change back from Split collapses.
    if (requested.canvasLayout === "single" && !layoutChanged) return;
    store.unsplitAllLayout(workspaceInstanceId);
    if (requested.canvasLayout === "single" || keys.length < 2) return;
    const first = getAllLeafNodes(currentUi().layoutTreeV2)[0];
    store.setLeafActiveTab(workspaceInstanceId, first.id, keys[0]);
    store.splitLayoutLeaf(workspaceInstanceId, first.id, "horizontal", keys[1]);
    if (requested.canvasLayout === "grid" && keys.length > 2) {
      const pair = getAllLeafNodes(currentUi().layoutTreeV2);
      store.splitLayoutLeaf(workspaceInstanceId, pair[0].id, "vertical", keys[2]);
      if (keys[3]) store.splitLayoutLeaf(workspaceInstanceId, pair[1].id, "vertical", keys[3]);
    }
    const current = currentUi();
    const selected = requested.activeFile ? fileKey(requested.activeFile) : keys[0];
    const group = Object.values(current.editorGroups).find((candidate) => candidate.activeKey === selected);
    if (group) store.setActiveEditorGroup(workspaceInstanceId, group.id);
  }, [workspaceInstanceId]);
  useEffect(() => {
    if (host && ready) reconcile(host);
  }, [host, ready, reconcile]);
  return reconcile;
}
