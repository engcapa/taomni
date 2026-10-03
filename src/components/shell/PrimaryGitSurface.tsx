import { useEffect, useRef, type ReactNode } from "react";
import { useAppStore } from "../../stores/appStore";
import { useShellLayoutStore, panelVisibility } from "../../stores/shellLayoutStore";
import { registerPanelActions } from "../../lib/shell/panelActions";
import { registerCloseAdapter, getCloseAdapter, registerCloseTarget, requestTabClose } from "../../lib/shell/closeCoordinator";
import { detachGitPanel, focusGitPanelWindow, reattachGitPanel } from "../../lib/shell/gitPanelWindow";
import type { GitTabInfo } from "../../types";
import { StableSurface } from "./SurfaceSlot";

export function PrimaryGitSurface({ tabId, title, info, children }: { tabId: string; title: string; info: GitTabInfo; children: ReactNode }) {
  const id = `tab:${tabId}:git`, shell = useShellLayoutStore(), active = useAppStore((s) => s.activeTabId);
  const latest = useRef({ title, info }); latest.current = { title, info };
  useEffect(() => {
    const state = useShellLayoutStore.getState();
    state.registerPanel({ id, kind: "git", owner: { kind: "tab", tabId, restoreRef: state.restoreRefByTab[tabId] }, generation: 1, phase: "ready", requestedOpen: true, pinned: true, placement: { kind: "primary", tabId }, operation: null, error: null });
    const offActions = registerPanelActions(id, { detach: () => {
      const { title, info } = latest.current;
      return detachGitPanel(id, title, info.workspaceRoots?.length ? info.workspaceRoots : [{ id: info.repoRoot, name: info.workspaceName ?? title, path: info.repoRoot, repoRoot: info.repoRoot, rootIds: [info.repoRoot] }], info.activeRepoRoot ?? info.repoRoot, !info.workspaceRoots?.length).catch(() => undefined);
    }, focus: () => focusGitPanelWindow(id), reattach: () => reattachGitPanel(id), close: async () => { await requestTabClose([tabId]); } });
    const adapter = { getRisks: (exit: boolean) => getCloseAdapter(id)?.getRisks(exit) ?? Promise.resolve([]), resolve: (...args: Parameters<NonNullable<ReturnType<typeof getCloseAdapter>>["resolve"]>) => getCloseAdapter(id)?.resolve(...args) ?? Promise.resolve(), flush: (signal: AbortSignal) => getCloseAdapter(id)?.flush(signal) ?? Promise.resolve() };
    const offAdapter = registerCloseAdapter(tabId, adapter);
    const offTarget = registerCloseTarget(id, () => ({ id, title: latest.current.title, adapter, commit: () => {
      useShellLayoutStore.getState().removePanel(id); useAppStore.getState().commitRemoveTab(tabId);
    } }));
    return () => { offActions(); offAdapter(); offTarget(); };
  }, [id, tabId]);
  const panel = shell.panels[id]; if (!panel) return null;
  const visibility = panelVisibility(panel, active, shell.taoOpen, shell.layout.tao.edge);
  return <StableSurface id={id} slot={panel.placement.kind === "primary" ? `primary:${panel.placement.tabId}` : visibility === "visible" ? `panel:${id}` : "parking"} visible={visibility === "visible"}>{children}</StableSurface>;
}
