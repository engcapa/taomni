import { useEffect, useRef } from "react";
import { ToolWindowSlot, type ToolWindowNodes } from "../editor/workspace/panels/ToolWindowHost";
import { StableSurface } from "./SurfaceSlot";
import { useAppStore } from "../../stores/appStore";
import { useShellLayoutStore, panelVisibility } from "../../stores/shellLayoutStore";
import { registerPanelActions } from "../../lib/shell/panelActions";
import { registerCloseTarget, getCloseAdapter, requestTabClose } from "../../lib/shell/closeCoordinator";
import { detachGitPanel, focusGitPanelWindow, reattachGitPanel } from "../../lib/shell/gitPanelWindow";
import type { CodeWorkspaceGitManagerPayload } from "../editor/CodeWorkspaceTab";

/** Adopts the workspace's existing node; it never renders a second tree or Git controller. */
export function WorkspaceToolSurface({ tabId, workspaceInstanceId, tool, nodes, label, requested, setRequested, gitPayload, hostEdge, onHostMove, onHostHide }: {
  tabId: string; workspaceInstanceId: string; tool: "project" | "git" | "problems" | "terminal";
  nodes: ToolWindowNodes; label: string; requested: boolean; setRequested(open: boolean): void;
  gitPayload?: CodeWorkspaceGitManagerPayload;
  hostEdge?: "right" | "bottom";
  onHostMove?(edge: "right" | "bottom"): void;
  onHostHide?(): void;
}) {
  const shell = useShellLayoutStore(), activeTabId = useAppStore((s) => s.activeTabId);
  const kind = tool === "terminal" ? "workspace-terminal" : tool === "project" ? "git" : tool;
  const id = `workspace:${workspaceInstanceId}:${tool}`;
  const callback = useRef(setRequested); callback.current = setRequested;
  const labelRef = useRef(label); labelRef.current = label;
  const gitRef = useRef(gitPayload); gitRef.current = gitPayload;
  const moveRef = useRef(onHostMove); moveRef.current = onHostMove;
  const hideRef = useRef(onHostHide); hideRef.current = onHostHide;
  const lastRequested = useRef(false);
  useEffect(() => {
    const s = useShellLayoutStore.getState();
    if (tool === "project") {
      if (activeTabId !== tabId) return;
      if (requested && !lastRequested.current) {
        s.updateLayout((l) => ({ ...l, navigator: { ...l.navigator, lastArea: "workspaces", collapsedByLane: { ...l.navigator.collapsedByLane, build: false } } }));
        s.setNavigatorPage("project");
      }
    } else if (requested) {
      if (!s.panels[id]) s.registerPanel({ id, kind, owner: { kind: "workspace", tabId, workspaceInstanceId, restoreRef: `workspace:${workspaceInstanceId}` }, generation: 1,
        phase: "ready", requestedOpen: true, pinned: s.layout.panelDefaults[kind].pinned, placement: { kind: "dock", edge: hostEdge ?? s.layout.panelDefaults[kind].edge }, operation: null, error: null });
      if (!lastRequested.current || !s.panels[id]?.requestedOpen) s.openPanel(id);
    } else if (lastRequested.current && s.panels[id]) s.hidePanel(id);
    lastRequested.current = requested;
  }, [requested, tool, kind, id, tabId, workspaceInstanceId, activeTabId]);
  useEffect(() => {
    const state = useShellLayoutStore.getState(), panel = state.panels[id];
    if (hostEdge && panel?.placement.kind === "dock" && panel.placement.edge !== hostEdge) {
      state.patchPanel(id, { placement: { kind: "dock", edge: hostEdge } });
      if (panel.requestedOpen) state.openPanel(id);
    }
  }, [id, hostEdge]);
  useEffect(() => {
    if (tool === "project") return registerPanelActions(id, { focus: () => {
      callback.current(true);
      const s = useShellLayoutStore.getState();
      s.updateLayout((l) => ({ ...l, navigator: { ...l.navigator, lastArea: "workspaces", collapsedByLane: { ...l.navigator.collapsedByLane, build: false } } }));
      s.setNavigatorPage("project");
    } });
    const off = registerPanelActions(id, {
      open: () => callback.current(true),
      move: (edge) => {
        moveRef.current?.(edge);
        const s = useShellLayoutStore.getState();
        s.patchPanel(id, { placement: { kind: "dock", edge }, requestedOpen: true });
        s.openPanel(id);
      },
      hide: () => { useShellLayoutStore.getState().hidePanel(id); hideRef.current?.(); },
      ...(tool === "git" ? { promote: () => {
        const s = useShellLayoutStore.getState(), panel = s.panels[id]; if (!panel) return;
        const promotedId = `shell-primary:${id}`;
        const existing = useAppStore.getState().tabs.find((tab) => tab.id === promotedId);
        if (existing) useAppStore.getState().setActiveTab(promotedId);
        else useAppStore.getState().addTab({ id: promotedId, type: "git", title: labelRef.current, closable: true, shellPanelId: id });
        s.patchPanel(id, { placement: { kind: "primary", tabId: promotedId }, requestedOpen: true });
      }, detach: async () => { const payload = gitRef.current; if (!payload) return; await detachGitPanel(id, payload.workspaceName, payload.roots, payload.activeRepoRoot ?? undefined).catch(() => undefined); },
        focus: () => focusGitPanelWindow(id), reattach: () => reattachGitPanel(id),
      } : {}),
      close: async () => { await requestTabClose([id]); },
    });
    const offTarget = registerCloseTarget(id, () => ({ id, title: labelRef.current, adapter: getCloseAdapter(id) ?? { getRisks: async () => [], resolve: async () => undefined, flush: async () => undefined }, commit: () => { callback.current(false); useShellLayoutStore.getState().removePanel(id); } }));
    const unsubscribe = useShellLayoutStore.subscribe((state, previous) => {
      const now = state.panels[id], before = previous.panels[id];
      if (now && before && now.requestedOpen !== before.requestedOpen && now.requestedOpen !== lastRequested.current) callback.current(now.requestedOpen);
    });
    return () => { off(); offTarget(); unsubscribe(); useShellLayoutStore.getState().removePanel(id); };
  }, [id, tool]);
  if (tool === "project") {
    const visible = requested && activeTabId === tabId && shell.layout.navigator.lastArea === "workspaces" && shell.navigatorPage === "project";
    return <StableSurface id={id} slot={visible ? "navigator-project" : "parking"} visible={visible}><ToolWindowSlot nodes={nodes} id="project" label={label} /></StableSurface>;
  }
  const panel = shell.panels[id];
  if (!panel) return null;
  const visibility = panelVisibility(panel, activeTabId, shell.taoOpen, shell.layout.tao.edge);
  const slot = panel.placement.kind === "primary" ? `primary:${panel.placement.tabId}` : visibility === "visible" ? `panel:${id}` : "parking";
  return <StableSurface id={id} slot={slot} visible={visibility === "visible"}><ToolWindowSlot nodes={nodes} id={tool} label={label} /></StableSurface>;
}
