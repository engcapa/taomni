import type { Tab } from "../../types";

export const EXPLORER_TABS_KEY = "taomni.explorer.tabs.v1";
export const EXPLORER_RESTORE_KEY = "taomni.explorer.restoreTabs.v1";
export const EXPLORER_RESTORE_EVENT = "taomni:explorer-restore-preference";

export interface ExplorerTabSnapshot {
  tabs: Tab[];
  activeTabId: string | null;
}

export function readExplorerRestoreEnabled(): boolean {
  try { return localStorage.getItem(EXPLORER_RESTORE_KEY) !== "false"; } catch { return true; }
}

export function setExplorerRestoreEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(EXPLORER_RESTORE_KEY, String(enabled));
    if (!enabled) localStorage.removeItem(EXPLORER_TABS_KEY);
  } catch { /* Storage can be unavailable in a restricted WebView; keep the UI usable. */ }
  window.dispatchEvent(new Event(EXPLORER_RESTORE_EVENT));
}

/** Recovery metadata contains no credentials, copied files, selection or tasks. */
export function explorerTabSnapshot(tabs: readonly Tab[], activeTabId: string | null): ExplorerTabSnapshot {
  return {
    tabs: tabs.filter((tab) => tab.type === "file-browser" && !!tab.fileBrowser).map((tab) => ({
      id: tab.id, type: "file-browser", title: tab.title, closable: true,
      ...(tab.sessionId ? { sessionId: tab.sessionId } : {}),
      fileBrowser: { initialPath: tab.fileBrowser!.initialPath, explorer: true },
    })),
    activeTabId,
  };
}

export function readExplorerTabSnapshot(): ExplorerTabSnapshot {
  try {
    const value = JSON.parse(localStorage.getItem(EXPLORER_TABS_KEY) ?? "null") as ExplorerTabSnapshot | null;
    const ids = new Set<string>();
    const tabs = (Array.isArray(value?.tabs) ? value.tabs : []).filter((tab) => {
      if (!tab || tab.type !== "file-browser" || typeof tab.id !== "string" || !tab.id || ids.has(tab.id)
        || typeof tab.title !== "string" || typeof tab.fileBrowser?.initialPath !== "string" || !tab.fileBrowser.initialPath) return false;
      ids.add(tab.id);
      return true;
    });
    return explorerTabSnapshot(tabs, typeof value?.activeTabId === "string" ? value.activeTabId : null);
  } catch { return { tabs: [], activeTabId: null }; }
}

export function writeExplorerTabSnapshot(tabs: readonly Tab[], activeTabId: string | null): void {
  if (!readExplorerRestoreEnabled()) return;
  localStorage.setItem(EXPLORER_TABS_KEY, JSON.stringify(explorerTabSnapshot(tabs, activeTabId)));
}
