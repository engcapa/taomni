import { useLayoutEffect, useRef, useState } from "react";
import { useAppStore } from "../stores/appStore";
import { useShellLayoutStore } from "../stores/shellLayoutStore";
import { CloseCoordinator, getCloseAdapter, getSurfaceCloseTarget, listSurfaceCloseTargets, installTabCloseHandler, type CloseAdapter, type ClosePlanItem, type CloseResult, type CloseProgress } from "../lib/shell/closeCoordinator";
import { closeSuccessor } from "../lib/shell/tabPresentation";
import { getQueryTab } from "../lib/queryRegistry";
import { promotedCloseTarget } from "../lib/shell/promotedSurfaceClose";
import type { CloseChoice } from "../lib/shell/types";
import { ShellCloseDialog } from "../components/shell/ShellCloseDialog";

interface DialogState { items: ClosePlanItem[]; errors: CloseResult["failed"]; progress?: CloseProgress; resolve(choices: Record<string, CloseChoice> | null): void }
export function useShellCloseBridge() {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const dialogRef = useRef(dialog); dialogRef.current = dialog;
  useLayoutEffect(() => {
    const coordinator = new CloseCoordinator((items, errors, progress) => new Promise((resolve) => setDialog({ items, errors, progress, resolve })));
    const uninstall = installTabCloseHandler((ids, exit = false) => {
      const state = useAppStore.getState();
      if (exit) ids = [...new Set([...ids, ...listSurfaceCloseTargets().filter((target) => {
        const panel = useShellLayoutStore.getState().panels[target.id];
        return !(panel?.owner.kind === "tab" && panel.placement.kind === "primary" && panel.placement.tabId === panel.owner.tabId && ids.includes(panel.owner.tabId));
      }).map((target) => target.id)])];
      else ids = [...new Set(ids.flatMap((id) => [
        ...Object.values(useShellLayoutStore.getState().panels).filter((panel) => panel.owner.kind === "workspace" && panel.owner.tabId === id && panel.placement.kind === "dock").map((panel) => panel.id), id,
      ]))];
      const targets = ids.flatMap((id) => {
        const surface = getSurfaceCloseTarget(id);
        if (surface) return [surface];
        const tab = state.tabs.find((item) => item.id === id);
        if (!tab?.closable) return [];
        if (tab.shellPanelId) return [promotedCloseTarget(tab.shellPanelId, id, tab.title)];
        const adapter: CloseAdapter = getCloseAdapter(id) ?? {
          getRisks: async () => [], resolve: async () => undefined,
          flush: async () => { await getQueryTab(id)?.flushWorkspace?.(); },
        };
        let resolutionMessage: string | undefined;
        const closeAdapter: CloseAdapter = {
          getRisks: (exit) => adapter.getRisks(exit),
          resolve: async (risk, choice, signal) => {
            const previous = useAppStore.getState().statusMessage;
            await adapter.resolve(risk, choice, signal);
            const message = useAppStore.getState().statusMessage;
            if (message !== previous) resolutionMessage = message;
          },
          flush: (signal) => adapter.flush(signal),
        };
        return [{ id, title: tab.title, adapter: closeAdapter, commit: () => {
          const current = useAppStore.getState(), shell = useShellLayoutStore.getState();
          const successor = closeSuccessor(current.tabs, new Set([id]), current.activeTabId, shell.mru, shell.laneOverrides);
          current.commitRemoveTab(id);
          if (resolutionMessage) useAppStore.getState().setStatusMessage(resolutionMessage);
          for (const panel of Object.values(shell.panels)) if (panel.owner.kind === "tab" && panel.owner.tabId === id && panel.placement.kind === "primary" && panel.placement.tabId === id) shell.removePanel(panel.id);
          if (successor && current.activeTabId === id) useAppStore.getState().setActiveTab(successor);
        } }];
      });
      return coordinator.request(targets, exit);
    }, (id) => {
      const tab = useAppStore.getState().tabs.find((item) => item.id === id);
      const adapter = getCloseAdapter(id);
      if (!tab || !adapter) return Promise.resolve({ status: tab ? "closed" : "failed", closed: [], failed: [] });
      return coordinator.request([{ id: `move:${id}`, title: tab.title, adapter, commit: () => undefined }]);
    }, (targets, exit) => coordinator.request(targets, exit));
    return () => { uninstall(); dialogRef.current?.resolve(null); };
  }, []);
  const finish = (choices: Record<string, CloseChoice> | null) => { const pending = dialog; setDialog(null); pending?.resolve(choices); };
  return dialog ? <ShellCloseDialog key={dialog.items.map((item) => item.target.id + item.risks.map((risk) => risk.revision).join()).join()} items={dialog.items} errors={dialog.errors} progress={dialog.progress} onFinish={finish} /> : null;
}
