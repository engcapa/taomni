import type { Tab } from "../../types";
import type { PanelInstance } from "./types";

/** Resolve once for every entry (toolbar, keymap, palette), using instance identity. */
export function contextPanelTarget(tab: Tab | undefined, panels: Record<string, PanelInstance>): string | null {
  if (!tab) return null;
  if (tab.shellPanelId) return tab.shellPanelId;
  const owned = Object.values(panels).filter((panel) => panel.owner.kind !== "background" && panel.owner.tabId === tab.id);
  const existing = owned.find((panel) => panel.requestedOpen) ?? owned[0];
  if (existing) return existing.id;
  if (tab.type === "terminal" && tab.ssh) return `tab:${tab.id}:sftp`;
  if (tab.type === "code-workspace" && tab.codeWorkspace?.workspaceInstanceId) return `workspace:${tab.codeWorkspace.workspaceInstanceId}:terminal`;
  return null;
}
