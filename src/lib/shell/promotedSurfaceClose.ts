import { useAppStore } from "../../stores/appStore";
import { useShellLayoutStore } from "../../stores/shellLayoutStore";
import { getCloseAdapter, type CloseAdapter, type CloseTarget } from "./closeCoordinator";
import type { CloseChoice, CloseRisk } from "./types";
import { t } from "../i18n";

export function promotedCloseTarget(panelId: string, tabId: string, title: string, business?: CloseAdapter): CloseTarget {
  let choice: CloseChoice | null = null;
  const adapter = business ?? getCloseAdapter(panelId);
  return {
    id: tabId, title,
    adapter: {
      getRisks: async (exit): Promise<CloseRisk[]> => {
        const panel = useShellLayoutStore.getState().panels[panelId];
        if (!panel || panel.placement.kind !== "primary") return [];
        if (exit) { choice = "close-instance"; return await adapter?.getRisks(true) ?? []; }
        if (!choice) return [{ kind: "surface", id: `${panelId}:placement`, ownerId: tabId, revision: String(panel.generation), detail: t("shell.closePromoted"), choices: ["dock", "close-instance", "cancel"] }];
        return choice === "dock" ? [] : await adapter?.getRisks(false) ?? [];
      },
      resolve: async (risk, selected, signal) => {
        if (risk.kind === "surface") {
          const panel = useShellLayoutStore.getState().panels[panelId];
          if (selected === "dock" && (!panel || panel.owner.kind === "background" || !useAppStore.getState().tabs.some((tab) => panel.owner.kind !== "background" && tab.id === panel.owner.tabId)))
            throw new Error(t("shell.ownerUnavailable"));
          choice = selected;
        } else await adapter?.resolve(risk, selected, signal);
      },
      flush: async (signal) => { if (choice !== "dock") await adapter?.flush(signal); },
    },
    commit: () => {
      const shell = useShellLayoutStore.getState(), panel = shell.panels[panelId];
      if (choice === "dock" && panel) { shell.patchPanel(panelId, { placement: { kind: "dock", edge: shell.layout.panelDefaults[panel.kind].edge }, requestedOpen: true });
        if (panel.owner.kind !== "background") useAppStore.getState().setActiveTab(panel.owner.tabId);
        shell.openPanel(panelId);
      } else shell.removePanel(panelId);
      useAppStore.getState().commitRemoveTab(tabId);
    },
  };
}
