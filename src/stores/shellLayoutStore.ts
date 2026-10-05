import { create } from "zustand";
import type { BusinessLane, NavigatorArea, PanelInstance, PersistedShellLayoutV2, TabLane, ShellRestoreSource } from "../lib/shell/types";
import { defaultShellLayout, loadShellLayout, SHELL_LAYOUT_KEY, validateShellLayout } from "../lib/shell/shellLayoutPersistence";
import { ownerMatches } from "../lib/shell/tabPresentation";
import { isTauriRuntime } from "../lib/runtime";
import { NativeLayoutPersistence } from "../lib/shell/nativeLayoutPersistence";

interface ShellState {
  layout: PersistedShellLayoutV2;
  initialized: boolean;
  writable: boolean;
  exiting: boolean;
  warning: string | null;
  laneSelection: TabLane | null;
  laneOverrides: Record<string, BusinessLane>;
  pinnedTabs: Record<string, boolean>;
  mru: string[];
  mruCycling: boolean;
  overlayTarget: string | null;
  overlay: "overview" | "quick" | "panels" | "actions" | null;
  immersive: boolean;
  immersiveReveal: "navigator" | "panel" | "tao" | "toolbar" | "workspace" | null;
  toggleImmersive(): void;
  navigatorOverlay: boolean;
  navigatorPage: "recent" | "project" | "tools";
  taoOpen: boolean;
  transfersOpen: boolean;
  transferTarget: string | null;
  panels: Record<string, PanelInstance>;
  activePanelByEdge: Partial<Record<"right" | "bottom", string>>;
  restoreRefByTab: Record<string, string>;
  bindRestoreSource(tabId: string, source: ShellRestoreSource, order: number, active?: boolean): void;
  initialize(): void | Promise<void>;
  updateLayout(update: (layout: PersistedShellLayoutV2) => PersistedShellLayoutV2): void;
  resetLayout(): void;
  flush(): void;
  flushDurable(): Promise<void>;
  visitTab(id: string): void;
  pruneTabs(ids: string[]): void;
  selectLane(lane: TabLane | null): void;
  moveTab(id: string, lane?: BusinessLane): void;
  pinTab(id: string, pinned: boolean): void;
  setOverlay(overlay: ShellState["overlay"]): void;
  toggleNavigator(area: NavigatorArea, lane: TabLane): void;
  setNavigatorPage(page: ShellState["navigatorPage"]): void;
  setNavigatorCollapsed(lane: TabLane, collapsed: boolean): void;
  setTaoOpen(open: boolean): void;
  revealTransfers(jobId?: string): void;
  registerPanel(panel: PanelInstance): void;
  patchPanel(id: string, patch: Partial<PanelInstance>, generation?: number): void;
  openPanel(id: string): void;
  hidePanel(id: string): void;
  resizePanel(id: string, size: number): void;
  removePanel(id: string): void;
}
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let lastStoredLayout: string | null = null;
let nativePersistence: NativeLayoutPersistence | null = null;
let initialization: Promise<void> | undefined;
let resetNativeRecord = false;
let saveAttempt = 0;
function ownsRestorePreference(refs: Record<string, string>, tabId: string, ref: string): boolean {
  return Object.entries(refs).find(([, value]) => value === ref)?.[0] === tabId;
}
export const useShellLayoutStore = create<ShellState>((set, get) => ({
  layout: defaultShellLayout(), initialized: false, writable: true, exiting: false, warning: null,
  immersive: false, immersiveReveal: null,
  toggleImmersive: () => { set((state) => ({ immersive: !state.immersive, immersiveReveal: null, overlay: null, navigatorOverlay: false, overlayTarget: null })); window.dispatchEvent(new Event("resize")); },
  laneSelection: null, laneOverrides: {}, pinnedTabs: {}, mru: [], overlay: null,
  mruCycling: false, overlayTarget: null, navigatorOverlay: false, navigatorPage: "recent", taoOpen: false, transfersOpen: false, transferTarget: null, panels: {}, activePanelByEdge: {}, restoreRefByTab: {},
  bindRestoreSource: (tabId, source, order, active = false) => {
    if (get().exiting) return;
    const ref = source.kind === "workspace" ? `workspace:${source.workspaceInstanceId}` : `${source.kind === "run-entry" ? "run-entry" : "unsupported"}:${source.identity}`;
    const s = get(), first = !s.restoreRefByTab[tabId], pref = s.layout.restoredTabs[ref];
    // A saved connection has one legacy resume entry, but may have several live
    // tabs. Its first live owner restores the preference; new duplicates keep
    // independent pin/lane state and must not overwrite that owner's preference.
    const existingOwner = Object.values(s.restoreRefByTab).includes(ref);
    if (first) set({ restoreRefByTab: { ...s.restoreRefByTab, [tabId]: ref },
      ...(pref && !existingOwner ? { pinnedTabs: { ...s.pinnedTabs, [tabId]: pref.pinned }, laneOverrides: { ...s.laneOverrides, ...(pref.laneOverride ? { [tabId]: pref.laneOverride } : {}) } } : {}) });
    const current = get(), tabs = { pinned: !!current.pinnedTabs[tabId], order, ...(current.laneOverrides[tabId] ? { laneOverride: current.laneOverrides[tabId] } : {}) };
    if (ownsRestorePreference(current.restoreRefByTab, tabId, ref)
      && (JSON.stringify(current.layout.restoreSources[ref]) !== JSON.stringify(source) || JSON.stringify(current.layout.restoredTabs[ref]) !== JSON.stringify(tabs))) {
      current.updateLayout((layout) => ({ ...layout, restoreSources: { ...layout.restoreSources, [ref]: source }, restoredTabs: { ...layout.restoredTabs, [ref]: tabs } }));
    }
    // A delayed model bind records the restore identity without navigating.
    // The user may already have selected an empty lane while the tab connects.
    if (active && !get().mruCycling && get().layout.lastActiveRestoreRef !== ref)
      get().updateLayout((layout) => ({ ...layout, lastActiveRestoreRef: ref }));
  },
  initialize: () => {
    if (get().initialized) return;
    if (initialization) return initialization;
    if (isTauriRuntime()) {
      nativePersistence ??= new NativeLayoutPersistence();
      initialization = (async () => {
        const durable = await nativePersistence!.load();
        const storage = window.localStorage;
        const local = loadShellLayout(storage, window.innerWidth);
        // Preserve corrupt/unknown input until the user explicitly resets it.
        // Otherwise the acknowledged desktop record wins over a WebView cache
        // that may have lost its last writes during process exit.
        const loaded = durable !== null && local.writable
          ? loadShellLayout({ getItem: (key) => key === SHELL_LAYOUT_KEY ? durable : storage.getItem(key),
            setItem: (key, value) => storage.setItem(key, value), removeItem: (key) => storage.removeItem(key) }, window.innerWidth)
          : local;
        lastStoredLayout = storage.getItem(SHELL_LAYOUT_KEY);
        set({ ...loaded, initialized: true });
        get().flush();
        await nativePersistence!.settled();
      })().catch((error: unknown) => {
        // Keep the app usable without overwriting a record we could not read.
        if (!get().initialized) {
          const local = loadShellLayout(window.localStorage, window.innerWidth);
          lastStoredLayout = window.localStorage.getItem(SHELL_LAYOUT_KEY);
          set({ ...local, initialized: true, writable: false, warning: "read" });
        } else set({ warning: String(error).includes("SHELL_LAYOUT_CHANGED") ? "changed" : "write" });
      }).finally(() => { initialization = undefined; });
      return initialization;
    }
    try {
      const loaded = loadShellLayout(window.localStorage, window.innerWidth);
      lastStoredLayout = window.localStorage.getItem(SHELL_LAYOUT_KEY);
      set({ ...loaded, initialized: true });
    }
    catch { set({ initialized: true, warning: "read" }); }
  },
  updateLayout: (update) => {
    const layout = update(get().layout);
    set({ layout });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => get().flush(), 200);
  },
  flush: () => {
    clearTimeout(saveTimer);
    const attempt = ++saveAttempt;
    if (!get().initialized || !get().writable) return;
    try {
      // Preserve a newer document's preferences (or recovery input) instead of
      // overwriting them with this document's stale pagehide snapshot.
      if (window.localStorage.getItem(SHELL_LAYOUT_KEY) !== lastStoredLayout) {
        set({ warning: "changed", writable: false });
        return;
      }
      const value = JSON.stringify(validateShellLayout(get().layout) ?? defaultShellLayout());
      window.localStorage.setItem(SHELL_LAYOUT_KEY, value);
      lastStoredLayout = value;
      if (nativePersistence) {
        const reset = resetNativeRecord; resetNativeRecord = false;
        void nativePersistence.save(value, reset).then(() => {
          if (attempt === saveAttempt && get().warning === "write") set({ warning: null });
        }).catch((error: unknown) => {
          if (attempt !== saveAttempt) return;
          const changed = String(error).includes("SHELL_LAYOUT_CHANGED");
          set({ warning: changed ? "changed" : "write", ...(changed ? { writable: false } : {}) });
        });
      } else if (get().warning === "write") set({ warning: null });
    }
    catch { set({ warning: "write" }); }
  },
  flushDurable: async () => {
    await initialization;
    get().flush();
    await nativePersistence?.settled();
    if (get().writable && get().warning === "write") throw new Error("Could not save workspace layout");
  },
  resetLayout: () => { const old = get().layout; try { lastStoredLayout = window.localStorage.getItem(SHELL_LAYOUT_KEY); } catch { /* flush reports storage errors */ } resetNativeRecord = true; set({ layout: { ...defaultShellLayout(), restoreSources: old.restoreSources, restoredTabs: old.restoredTabs, lastActiveRestoreRef: old.lastActiveRestoreRef }, warning: null, writable: true, initialized: true, navigatorOverlay: false }); get().flush(); },
  visitTab: (id) => { set((s) => ({ laneSelection: null, ...(s.mruCycling ? {} : { mru: [id, ...s.mru.filter((item) => item !== id)] }) })); const s = get(), ref = s.restoreRefByTab[id]; if (!s.mruCycling && ref && s.layout.lastActiveRestoreRef !== ref) s.updateLayout((layout) => ({ ...layout, lastActiveRestoreRef: ref })); },
  pruneTabs: (ids) => { const live = new Set(ids), removed = Object.entries(get().restoreRefByTab).filter(([id]) => !live.has(id)).map(([, ref]) => ref); set((s) => ({ mru: s.mru.filter((id) => live.has(id)),
    restoreRefByTab: Object.fromEntries(Object.entries(s.restoreRefByTab).filter(([id]) => live.has(id))),
    laneOverrides: Object.fromEntries(Object.entries(s.laneOverrides).filter(([id]) => live.has(id))),
    pinnedTabs: Object.fromEntries(Object.entries(s.pinnedTabs).filter(([id]) => live.has(id))) }));
    if (removed.length && !get().exiting) get().updateLayout((layout) => ({ ...layout,
      restoreSources: Object.fromEntries(Object.entries(layout.restoreSources).filter(([ref]) => !removed.includes(ref) || Object.values(get().restoreRefByTab).includes(ref))),
      restoredTabs: Object.fromEntries(Object.entries(layout.restoredTabs).filter(([ref]) => !removed.includes(ref) || Object.values(get().restoreRefByTab).includes(ref))) })); },
  selectLane: (laneSelection) => set({ laneSelection }),
  moveTab: (id, lane) => { if (id === "welcome") return; set((s) => { const laneOverrides = { ...s.laneOverrides }; if (lane) laneOverrides[id] = lane; else delete laneOverrides[id]; return { laneOverrides }; }); const s = get(), ref = s.restoreRefByTab[id]; if (ref && s.layout.restoreSources[ref] && ownsRestorePreference(s.restoreRefByTab, id, ref)) s.updateLayout((layout) => { const pref = { ...layout.restoredTabs[ref] }; delete pref.laneOverride; return { ...layout, restoredTabs: { ...layout.restoredTabs, [ref]: { ...pref, ...(lane ? { laneOverride: lane } : {}) } } }; }); },
  pinTab: (id, pinned) => { if (id === "welcome") return; set((s) => ({ pinnedTabs: { ...s.pinnedTabs, [id]: pinned } })); const s = get(), ref = s.restoreRefByTab[id]; if (ref && s.layout.restoreSources[ref] && ownsRestorePreference(s.restoreRefByTab, id, ref)) s.updateLayout((layout) => ({ ...layout, restoredTabs: { ...layout.restoredTabs, [ref]: { ...layout.restoredTabs[ref], pinned } } })); },
  setOverlay: (overlay) => set({ overlay, navigatorOverlay: false }),
  setNavigatorPage: (navigatorPage) => set({ navigatorPage }),
  toggleNavigator: (area, lane) => {
    const current = get().layout.navigator;
    const visible = !current.collapsedByLane[lane] && (window.innerWidth >= 1200 || get().navigatorOverlay)
      && !(get().taoOpen && get().layout.tao.edge === "left");
    const collapsed = current.lastArea === area && visible;
    get().updateLayout((layout) => ({ ...layout, navigator: { ...layout.navigator, lastArea: area,
      collapsedByLane: { ...layout.navigator.collapsedByLane, [lane]: collapsed } } }));
    set({ navigatorOverlay: !collapsed, overlay: null, overlayTarget: collapsed ? null : "navigator" });
  },
  setNavigatorCollapsed: (lane, collapsed) => {
    if (get().immersive) { set({ immersiveReveal: collapsed ? null : "navigator", navigatorOverlay: !collapsed }); return; }
    get().updateLayout((layout) => ({ ...layout, navigator: { ...layout.navigator, collapsedByLane: { ...layout.navigator.collapsedByLane, [lane]: collapsed } } }));
    set({ navigatorOverlay: false });
  },
  setTaoOpen: (taoOpen) => set({ taoOpen, navigatorOverlay: false, overlay: null, overlayTarget: taoOpen ? "tao" : null }),
  revealTransfers: (jobId) => set({ transfersOpen: true, transferTarget: jobId ?? null, taoOpen: false, overlay: null, navigatorOverlay: false }),
  registerPanel: (panel) => set((s) => { if (Object.hasOwn(s.panels, panel.id)) return s; const pref = panel.owner.restoreRef && panel.placement.kind === "dock" ? s.layout.panelOverrides[`${panel.owner.restoreRef}:${panel.kind}`] : undefined; return { panels: { ...s.panels, [panel.id]: { ...panel, ...(pref ? { preferredSize: pref.size, pinned: pref.pinned, placement: { kind: "dock", edge: pref.edge } as const } : {}) } } }; }),
  patchPanel: (id, patch, generation) => { set((s) => {
    const panel = s.panels[id];
    return panel && (generation === undefined || panel.generation === generation) ? { panels: { ...s.panels, [id]: { ...panel, ...patch, id } } } : s;
  }); const s = get(), panel = s.panels[id], ref = panel?.owner.restoreRef;
    if (panel && ref && panel.placement.kind === "dock" && (patch.placement || patch.pinned !== undefined || patch.preferredSize !== undefined)) { const edge = panel.placement.edge; s.updateLayout((layout) => ({ ...layout, panelOverrides: { ...layout.panelOverrides, [`${ref}:${panel.kind}`]: { edge, pinned: panel.pinned, size: panel.preferredSize ?? layout.panelDefaults[panel.kind].size } } })); }
    if (panel && ref && patch.placement?.kind === "detached") s.updateLayout((layout) => ({ ...layout, recentPanels: [{ kind: panel.kind, restoreRef: ref, preferredPlacement: "detached" as const, lastUsedAt: Date.now() }, ...layout.recentPanels.filter((p) => p.restoreRef !== ref || p.kind !== panel.kind)].slice(0, 20) }));
  },
  openPanel: (id) => {
    const panel = get().panels[id];
    if (!panel) return;
    get().patchPanel(id, { requestedOpen: true });
    if (panel.owner.restoreRef) get().updateLayout((layout) => ({ ...layout, recentPanels: [{ kind: panel.kind, restoreRef: panel.owner.restoreRef!, preferredPlacement: panel.placement.kind === "detached" ? "detached" as const : "dock" as const, lastUsedAt: Date.now() }, ...layout.recentPanels.filter((p) => p.restoreRef !== panel.owner.restoreRef || p.kind !== panel.kind)].slice(0, 20) }));
    if (panel.placement.kind === "dock") {
      const edge = panel.placement.edge;
      set((s) => ({ activePanelByEdge: { ...s.activePanelByEdge, [edge]: id } }));
    }
    // Opening a destination must preserve the recent-panel dialog while its
    // asynchronous request is still waiting for readiness or showing an error.
    if (panel.placement.kind === "dock" && get().layout.tao.edge === panel.placement.edge) set({ taoOpen: false });
    set({ overlayTarget: id, navigatorOverlay: false });
  },
  hidePanel: (id) => get().patchPanel(id, { requestedOpen: false }),
  resizePanel: (id, size) => {
    const panel = get().panels[id]; if (!panel || !Number.isFinite(size)) return;
    const value = Math.min(600, Math.max(panel.placement.kind === "dock" && panel.placement.edge === "right" ? 280 : 220, size));
    get().patchPanel(id, { preferredSize: value });
    get().updateLayout((layout) => ({ ...layout, panelDefaults: { ...layout.panelDefaults, [panel.kind]: { ...layout.panelDefaults[panel.kind], size: value } } }));
  },
  removePanel: (id) => set((s) => { const panels = { ...s.panels }; delete panels[id]; return { panels }; }),
}));
export function panelVisibility(panel: PanelInstance, activeTabId: string | null, taoOpen: boolean, taoEdge: string): import("../lib/shell/types").PanelVisibility {
  if (panel.placement.kind === "detached") return ownerMatches(panel.owner, activeTabId) ? "detached-placeholder" : "inactive-owner";
  if (panel.placement.kind === "primary") return panel.placement.tabId === activeTabId ? "visible" : "inactive-owner";
  if (!ownerMatches(panel.owner, activeTabId) && panel.owner.kind !== "background") return "inactive-owner";
  if (!panel.requestedOpen) return "hidden";
  return taoOpen && taoEdge === panel.placement.edge ? "suppressed-by-tao" : "visible";
}
