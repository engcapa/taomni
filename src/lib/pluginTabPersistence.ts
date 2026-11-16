import { useAppStore } from "../stores/appStore";
import { readPluginTab } from "./pluginTabs";
import type { Tab } from "../types";

const KEY = "taomni.plugin-tabs.v1";

/** Persist locators only. No manifest, executable path, payload or permission is restored. */
export function attachPluginTabPersistence(storage: Storage = localStorage): () => void {
  try {
    const raw = storage.getItem(KEY);
    const saved = raw && raw.length <= 128_000 ? JSON.parse(raw) : null;
    if (saved?.version === 1 && Array.isArray(saved.tabs) && saved.tabs.length <= 128) {
      const tabs: Tab[] = [];
      const ids = new Set(useAppStore.getState().tabs.map((tab) => tab.id));
      for (const entry of saved.tabs) {
        const tab = readPluginTab(entry);
        if (!tab || ids.has(tab.id)) continue;
        ids.add(tab.id);
        tabs.push(tab);
      }
      useAppStore.setState((state) => ({ tabs: [...state.tabs, ...tabs] }));
      if (tabs.some((tab) => tab.id === saved.activeTabId)) {
        // Use the ordinary focus action so the restored tab also becomes
        // visible in Sessions instead of remaining mounted behind Home.
        useAppStore.getState().setActiveTab(saved.activeTabId as string);
      }
    }
  } catch { /* Corrupt/blocked browser storage cannot authorize or remove a tab. */ }
  let last = "";
  const save = () => {
    const state = useAppStore.getState();
    const tabs = state.tabs.filter((tab) => tab.type === "plugin").slice(0, 128).map(readPluginTab).filter(Boolean);
    const activeTabId = ["home", "workspaces", "agents"].includes(state.activeSideTab)
      ? null : state.activeTabId;
    const raw = JSON.stringify({ version: 1, tabs, activeTabId });
    if (raw === last) return;
    last = raw;
    try { storage.setItem(KEY, raw); } catch { /* Keep the live tab usable. */ }
  };
  const stop = useAppStore.subscribe((next, old) => {
    if (next.tabs !== old.tabs || next.activeTabId !== old.activeTabId || next.activeSideTab !== old.activeSideTab) save();
  });
  save();
  return stop;
}
