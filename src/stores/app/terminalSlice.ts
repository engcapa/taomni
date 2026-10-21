import { type StateCreator } from "zustand";
import { t as tr } from "../../lib/i18n";
import { detectXServer } from "../../lib/ipc";
import { type AppState, type TerminalRuntimeInfo } from "./types";
import { readTerminalSplitLayout, writeTerminalSplitLayout } from "./preferences";
import { activeTabIsTerminal, omitRecordKeys } from "./policies";

export const createTerminalSlice: StateCreator<AppState, [], [], Pick<AppState, "cwdByTab" | "terminalRuntimeByTab" | "xServerEnabled" | "xServerStatus" | "multiExecActive" | "multiExecSelectedTabIds" | "terminalSplitActive" | "terminalSplitLayout" | "terminalSplitInputLockedTabIds" | "refreshXServer" | "toggleXServer" | "toggleMultiExec" | "toggleMultiExecTab" | "selectAllTerminalTabs" | "clearMultiExecSelection" | "setTerminalSplitActive" | "toggleTerminalSplit" | "setTerminalSplitLayout" | "toggleTerminalSplitInputLock" | "clearTerminalSplitInputLocks" | "setTabHasNewOutput" | "setTabCwd" | "setTerminalRuntime">> = (set) => ({
  cwdByTab: {},
  terminalRuntimeByTab: {},
  xServerEnabled: false,
  xServerStatus: null,
  multiExecActive: false,
  multiExecSelectedTabIds: new Set(),
  terminalSplitActive: false,
  terminalSplitLayout: readTerminalSplitLayout(),
  terminalSplitInputLockedTabIds: new Set(),

  refreshXServer: async () => {
    const status = await detectXServer();
    set({
      xServerStatus: status,
      xServerEnabled: status.available,
    });
  },

  // The "X server" ribbon/menu command now means "re-detect", since whether a
  // local X server exists is a property of the system, not something the app
  // turns on. We re-probe and report the result in the status line.
  toggleXServer: () => {
    void detectXServer().then((status) => {
      set({
        xServerStatus: status,
        xServerEnabled: status.available,
        statusMessage: status.available
          ? tr("status.xServerEnabled")
          : tr("status.xServerDisabled"),
      });
    });
  },

  toggleMultiExec: () =>
    set((s) => {
      const next = !s.multiExecActive;
      return {
        multiExecActive: next,
        multiExecSelectedTabIds: new Set(),
        tabs: next ? s.tabs : s.tabs.map((t) => ({ ...t, hasNewOutput: false })),
        statusMessage: next ? tr("status.multiExecEnabled") : tr("status.multiExecDisabled"),
      };
    }),

  toggleMultiExecTab: (tabId) =>
    set((s) => {
      const next = new Set(s.multiExecSelectedTabIds);
      if (next.has(tabId)) {
        next.delete(tabId);
      } else {
        next.add(tabId);
      }
      return { multiExecSelectedTabIds: next };
    }),

  selectAllTerminalTabs: () =>
    set((s) => ({
      multiExecSelectedTabIds: new Set(
        s.tabs.filter((t) => t.type === "terminal").map((t) => t.id),
      ),
    })),

  clearMultiExecSelection: () =>
    set({ multiExecSelectedTabIds: new Set() }),

  setTerminalSplitActive: (active) =>
    set((s) => {
      if (!active) {
        return {
          terminalSplitActive: false,
          statusMessage: tr("status.splitDisabled"),
        };
      }
      const terminalTabs = s.tabs.filter((tab) => tab.type === "terminal");
      if (terminalTabs.length === 0) {
        return {
          terminalSplitActive: false,
          statusMessage: tr("status.splitNoTerminals"),
        };
      }
      const activeTabId = activeTabIsTerminal(s.tabs, s.activeTabId)
        ? s.activeTabId
        : terminalTabs[0].id;
      return {
        terminalSplitActive: true,
        activeTabId,
        statusMessage: tr("status.splitEnabled"),
      };
    }),

  toggleTerminalSplit: () =>
    set((s) => {
      if (s.terminalSplitActive) {
        return {
          terminalSplitActive: false,
          statusMessage: tr("status.splitDisabled"),
        };
      }
      const terminalTabs = s.tabs.filter((tab) => tab.type === "terminal");
      if (terminalTabs.length === 0) {
        return {
          terminalSplitActive: false,
          statusMessage: tr("status.splitNoTerminals"),
        };
      }
      const activeTabId = activeTabIsTerminal(s.tabs, s.activeTabId)
        ? s.activeTabId
        : terminalTabs[0].id;
      return {
        terminalSplitActive: true,
        activeTabId,
        statusMessage: tr("status.splitEnabled"),
      };
    }),

  setTerminalSplitLayout: (layout) => {
    writeTerminalSplitLayout(layout);
    set({
      terminalSplitLayout: layout,
      statusMessage: tr("status.splitLayout", { layout }),
    });
  },

  toggleTerminalSplitInputLock: (tabId) =>
    set((s) => {
      if (!s.tabs.some((tab) => tab.id === tabId && tab.type === "terminal")) {
        return s;
      }
      const next = new Set(s.terminalSplitInputLockedTabIds);
      if (next.has(tabId)) {
        next.delete(tabId);
      } else {
        next.add(tabId);
      }
      return {
        terminalSplitInputLockedTabIds: next,
        statusMessage: next.has(tabId) ? tr("status.paneInputLocked") : tr("status.paneInputUnlocked"),
      };
    }),

  clearTerminalSplitInputLocks: () =>
    set({
      terminalSplitInputLockedTabIds: new Set(),
      statusMessage: tr("status.splitLocksCleared"),
    }),

  setTabHasNewOutput: (tabId, hasNewOutput) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId);
      if (!tab || tab.hasNewOutput === hasNewOutput) return s;
      return { tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, hasNewOutput } : t)) };
    }),
  setTabCwd: (tabId, cwd) =>
    set((s) => (s.cwdByTab[tabId] === cwd ? s : { cwdByTab: { ...s.cwdByTab, [tabId]: cwd } })),

  setTerminalRuntime: (tabId, patch) =>
    set((s) => {
      if (patch === null) {
        if (!(tabId in s.terminalRuntimeByTab)) return s;
        return { terminalRuntimeByTab: omitRecordKeys(s.terminalRuntimeByTab, new Set([tabId])) };
      }
      const current = s.terminalRuntimeByTab[tabId];
      const merged = {
        ...current,
        ...patch,
        state: patch.state ?? current?.state ?? "unknown",
      };
      if (
        current &&
        current.backendSessionId === merged.backendSessionId &&
        current.state === merged.state &&
        current.program === merged.program &&
        current.activitySource === merged.activitySource
      ) {
        return s;
      }
      const next: TerminalRuntimeInfo = { ...merged, updatedAt: patch.updatedAt ?? Date.now() };
      return { terminalRuntimeByTab: { ...s.terminalRuntimeByTab, [tabId]: next } };
    })
});
