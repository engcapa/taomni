import { useSyncExternalStore } from "react";

export interface ExplorerPreferences {
  view: "details" | "list" | "icons";
  sortKey: "name" | "mtime" | "type" | "size";
  sortDir: "asc" | "desc";
  showHidden: boolean;
  preview: boolean;
  previewPosition: "right" | "bottom";
  previewWidth: number;
  navWidth: number;
  wrap: boolean;
  pinnedPaths: string[];
  expandedPaths: string[];
}

export const EXPLORER_PREFERENCES_KEY = "taomni.explorer.view.v1";
const defaults: ExplorerPreferences = {
  view: "details", sortKey: "name", sortDir: "asc", showHidden: false,
  preview: true, previewPosition: "right", previewWidth: 300, navWidth: 210,
  wrap: false, pinnedPaths: [], expandedPaths: [],
};
const listeners = new Set<() => void>();
function readPreferences(): ExplorerPreferences {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(EXPLORER_PREFERENCES_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return { ...defaults };
    const p = raw as Record<string, unknown>;
    const paths = (v: unknown) => Array.isArray(v) ? v.filter((s): s is string => typeof s === "string").slice(0, 500) : [];
    return {
      view: p.view === "list" || p.view === "icons" ? p.view : "details",
      sortKey: p.sortKey === "mtime" || p.sortKey === "type" || p.sortKey === "size" ? p.sortKey : "name",
      sortDir: p.sortDir === "desc" ? "desc" : "asc",
      showHidden: p.showHidden === true,
      preview: typeof p.preview === "boolean" ? p.preview : true,
      previewPosition: p.previewPosition === "bottom" ? "bottom" : "right",
      previewWidth: typeof p.previewWidth === "number" && Number.isFinite(p.previewWidth) ? Math.min(600, Math.max(220, p.previewWidth)) : 300,
      navWidth: typeof p.navWidth === "number" && Number.isFinite(p.navWidth) ? Math.min(380, Math.max(140, p.navWidth)) : 210,
      wrap: p.wrap === true,
      pinnedPaths: paths(p.pinnedPaths), expandedPaths: paths(p.expandedPaths),
    };
  } catch { return { ...defaults }; }
}
let current = readPreferences();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function getExplorerPreferences() { return current; }
export function setExplorerPreferences(patch: Partial<ExplorerPreferences>) {
  current = { ...current, ...patch };
  try { localStorage.setItem(EXPLORER_PREFERENCES_KEY, JSON.stringify(current)); } catch { /* preferences remain usable without storage */ }
  listeners.forEach((listener) => listener());
}
export function useExplorerPreferences() {
  return useSyncExternalStore(subscribe, getExplorerPreferences, getExplorerPreferences);
}
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== EXPLORER_PREFERENCES_KEY) return;
    current = readPreferences();
    listeners.forEach((listener) => listener());
  });
}
