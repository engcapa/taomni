import { type StateCreator } from "zustand";
import type { Tab } from "../../types";
import { t as tr } from "../../lib/i18n";
import { sidebarRailGroup } from "../sidebarRailPolicy";
import { terminalCwdTitlePrefix } from "../../lib/terminalCwd";
import { getQueryTab } from "../../lib/queryRegistry";
import { computeDuplicateTitle, computeNewTerminalTitle, updateDuplicateAutoTitle } from "./tabTitles";
import { type AppState } from "./types";
import { upsertRecentWorkspaceForTab, writeRecentWorkspaces, newWorkspaceInstanceId } from "./recentWorkspaces";
import { terminalAutoTitleBase, activeTabIsTerminal, pruneSet, omitRecordKeys } from "./policies";

export const createTabsSlice: StateCreator<AppState, [], [], Pick<AppState, "tabs" | "activeTabId" | "tabFilter" | "addTab" | "duplicateTab" | "removeTab" | "removeTabs" | "updateTabVnc" | "updateTabTitle" | "assignTerminalAutoTitle" | "updateGitTabInfo" | "setActiveTab" | "moveTab" | "moveTabToIndex" | "setTabFilter" | "clearTabFilter">> = (set) => ({
  tabs: [
    {
      id: "welcome",
      type: "welcome",
      title: "Welcome",
      closable: false,
    },
  ],
  activeTabId: "welcome",
  tabFilter: null,

  addTab: (tab) =>
    set((s) => {
      const nextTabs = [...s.tabs, tab];
      const recentResult = upsertRecentWorkspaceForTab(
        s.recentWorkspaces,
        s.recentWorkspaceIdByWorkspaceInstance,
        tab,
        undefined,
        Date.now(),
        s.welcomeRecentSessionLimit,
      );
      if (recentResult.recentWorkspaces !== s.recentWorkspaces) {
        writeRecentWorkspaces(recentResult.recentWorkspaces);
      }
      return {
        tabs: nextTabs,
        activeTabId: tab.id,
        activeSideTab: ["home", "workspaces", "agents"].includes(s.activeSideTab) ? "sessions" : s.activeSideTab,
        recentWorkspaces: recentResult.recentWorkspaces,
        recentWorkspaceIdByWorkspaceInstance: recentResult.recentWorkspaceIdByWorkspaceInstance,
        // A freshly opened tab must be visible, so drop any active focus filter.
        tabFilter: null,
        terminalSplitActive: tab.type === "terminal" ? s.terminalSplitActive : false,
        statusMessage: tr("status.openedTab", { title: tab.title }),
      };
    }),

  duplicateTab: (id, overrides) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return s;
      const source = s.tabs[idx];
      const isTerminal = source.type === "terminal";
      // Explicit renames permanently opt out of cwd-derived titles. A duplicate
      // of a manual tab must keep that choice and sequence the renamed title
      // (`name` -> `name-1`), not replace it with the cwd basename.
      const sourceIsManual = isTerminal && source.terminalTitleMode === "manual";
      const terminalTitlePrefix =
        isTerminal && !sourceIsManual ? overrides?.terminalTitlePrefix?.trim() : undefined;
      const duplicateTitleBase = terminalTitlePrefix
        ? terminalAutoTitleBase(source, terminalTitlePrefix)
        : undefined;
      const duplicateTitle = duplicateTitleBase
        ? computeDuplicateTitle(
            duplicateTitleBase,
            s.tabs.filter((tab) => tab.type === "terminal").map((tab) => tab.title),
          )
        : computeDuplicateTitle(source.title, s.tabs.map((t) => t.title));
      const copy: Tab = {
        ...source,
        id: `dup-${crypto.randomUUID()}`,
        chatTabId: undefined,
        title: duplicateTitle,
        closable: true,
        hasNewOutput: false,
        // Only terminal copies carry an initial cwd; clear any inherited value
        // for other tab kinds (and when none was resolved). Cwd is still used
        // to open the shell in the same directory even when the title is manual.
        terminalInitialCwd:
          isTerminal ? overrides?.terminalInitialCwd : undefined,
        terminalTitleMode: isTerminal
          ? (sourceIsManual ? "manual" : terminalTitlePrefix ? "auto" : "pending-auto")
          : undefined,
        terminalTitleOperation: isTerminal && !sourceIsManual ? "duplicate" : undefined,
        terminalProfile:
          isTerminal ? overrides?.terminalProfile ?? source.terminalProfile : source.terminalProfile,
        codeWorkspace:
          source.type === "code-workspace" && source.codeWorkspace
            ? {
                ...source.codeWorkspace,
                workspaceInstanceId: newWorkspaceInstanceId(),
              }
            : source.codeWorkspace,
      };
      const next = s.tabs.slice();
      next.splice(idx + 1, 0, copy);
      const recentResult = upsertRecentWorkspaceForTab(
        s.recentWorkspaces,
        s.recentWorkspaceIdByWorkspaceInstance,
        copy,
        undefined,
        Date.now(),
        s.welcomeRecentSessionLimit,
      );
      if (recentResult.recentWorkspaces !== s.recentWorkspaces) {
        writeRecentWorkspaces(recentResult.recentWorkspaces);
      }
      return {
        tabs: next,
        activeTabId: copy.id,
        recentWorkspaces: recentResult.recentWorkspaces,
        recentWorkspaceIdByWorkspaceInstance: recentResult.recentWorkspaceIdByWorkspaceInstance,
        // A freshly opened tab must be visible, so drop any active focus filter.
        tabFilter: null,
        terminalSplitActive: copy.type === "terminal" ? s.terminalSplitActive : false,
        statusMessage: tr("status.openedTab", { title: copy.title }),
      };
    }),

  removeTab: (id) => {
    void getQueryTab(id)?.flushWorkspace?.();
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      const tab = idx >= 0 ? s.tabs[idx] : undefined;
      const next = s.tabs.filter((t) => t.id !== id);
      let activeId = s.activeTabId;
      if (activeId === id) {
        activeId = next[Math.min(idx, next.length - 1)]?.id ?? null;
      }
      const validIds = new Set(next.map((tab) => tab.id));
      const recentResult = upsertRecentWorkspaceForTab(
        s.recentWorkspaces,
        s.recentWorkspaceIdByWorkspaceInstance,
        tab,
        s.codeWorkspaceByTab[id],
        Date.now(),
        s.welcomeRecentSessionLimit,
      );
      if (recentResult.recentWorkspaces !== s.recentWorkspaces) {
        writeRecentWorkspaces(recentResult.recentWorkspaces);
      }
      return {
        tabs: next,
        activeTabId: activeId,
        recentWorkspaces: recentResult.recentWorkspaces,
        recentWorkspaceIdByWorkspaceInstance: recentResult.recentWorkspaceIdByWorkspaceInstance,
        terminalSplitActive: s.terminalSplitActive && activeTabIsTerminal(next, activeId),
        terminalSplitInputLockedTabIds: pruneSet(s.terminalSplitInputLockedTabIds, validIds),
        multiExecSelectedTabIds: pruneSet(s.multiExecSelectedTabIds, validIds),
        cwdByTab: omitRecordKeys(s.cwdByTab, new Set([id])),
        terminalRuntimeByTab: omitRecordKeys(s.terminalRuntimeByTab, new Set([id])),
        statusMessage: tr("status.closedTab"),
      };
    });
  },

  removeTabs: (ids) =>
    set((s) => {
      const idSet = new Set(ids);
      const activeIndex = s.tabs.findIndex((t) => t.id === s.activeTabId);
      const closingTabs = s.tabs.filter((tab) => idSet.has(tab.id));
      const next = s.tabs.filter((t) => !idSet.has(t.id));
      let activeId = s.activeTabId;
      if (!activeId || idSet.has(activeId)) {
        activeId = next[Math.min(activeIndex, next.length - 1)]?.id ?? null;
      }
      const validIds = new Set(next.map((tab) => tab.id));
      let recentWorkspaces = s.recentWorkspaces;
      let recentWorkspaceIdByWorkspaceInstance = s.recentWorkspaceIdByWorkspaceInstance;
      const now = Date.now();
      for (const tab of closingTabs) {
        const recentResult = upsertRecentWorkspaceForTab(
          recentWorkspaces,
          recentWorkspaceIdByWorkspaceInstance,
          tab,
          s.codeWorkspaceByTab[tab.id],
          now,
          s.welcomeRecentSessionLimit,
        );
        recentWorkspaces = recentResult.recentWorkspaces;
        recentWorkspaceIdByWorkspaceInstance = recentResult.recentWorkspaceIdByWorkspaceInstance;
      }
      if (recentWorkspaces !== s.recentWorkspaces) {
        writeRecentWorkspaces(recentWorkspaces);
      }
      return {
        tabs: next,
        activeTabId: activeId,
        recentWorkspaces,
        recentWorkspaceIdByWorkspaceInstance,
        terminalSplitActive: s.terminalSplitActive && activeTabIsTerminal(next, activeId),
        terminalSplitInputLockedTabIds: pruneSet(s.terminalSplitInputLockedTabIds, validIds),
        multiExecSelectedTabIds: pruneSet(s.multiExecSelectedTabIds, validIds),
        cwdByTab: omitRecordKeys(s.cwdByTab, idSet),
        terminalRuntimeByTab: omitRecordKeys(s.terminalRuntimeByTab, idSet),
        statusMessage: tr("status.closedTabs"),
      };
    }),

  updateTabVnc: (id, patch) =>
    set((s) => ({
      tabs: s.tabs.map((tab) => (tab.id === id && tab.vnc ? { ...tab, vnc: { ...tab.vnc, ...patch } } : tab)),
    })),

  updateTabTitle: (id, title) =>
    set((s) => ({
      tabs: s.tabs.map((tab) =>
        tab.id === id
          ? {
              ...tab,
              title,
              ...(tab.type === "terminal" ? { terminalTitleMode: "manual" as const } : {}),
            }
          : tab,
      ),
      statusMessage: tr("status.renamedTab", { title }),
    })),

  assignTerminalAutoTitle: (tabId, cwd) =>
    set((s) => {
      const target = s.tabs.find((tab) => tab.id === tabId);
      if (
        !target ||
        target.type !== "terminal" ||
        (target.terminalTitleMode !== "pending-auto" && target.terminalTitleMode !== "auto")
      ) {
        return s;
      }
      const cwdPrefix = terminalCwdTitlePrefix(cwd);
      if (!cwdPrefix) return s;
      const prefix = terminalAutoTitleBase(target, cwdPrefix);
      const openTitles = s.tabs
        .filter((tab) => tab.id !== tabId && tab.type === "terminal")
        .map((tab) => tab.title);
      const title = target.terminalTitleOperation === "duplicate"
        ? target.terminalTitleMode === "pending-auto"
          ? computeDuplicateTitle(prefix, openTitles)
          : updateDuplicateAutoTitle(target.title, prefix)
        : computeNewTerminalTitle(prefix, openTitles);
      if (target.title === title && target.terminalTitleMode === "auto") return s;
      return {
        tabs: s.tabs.map((tab) =>
          tab.id === tabId ? { ...tab, title, terminalTitleMode: "auto" as const } : tab,
        ),
      };
    }),

  updateGitTabInfo: (id, git, title) =>
    set((s) => {
      const tab = s.tabs.find((item) => item.id === id);
      if (!tab || tab.type !== "git") return s;
      return {
        tabs: s.tabs.map((item) => (
          item.id === id
            ? {
                ...item,
                title: title ?? item.title,
                git,
              }
            : item
        )),
      };
    }),

  setActiveTab: (id) =>
    set((s) => {
      const tab = s.tabs.find((item) => item.id === id);
      const recentResult = upsertRecentWorkspaceForTab(
        s.recentWorkspaces,
        s.recentWorkspaceIdByWorkspaceInstance,
        tab,
        s.codeWorkspaceByTab[id],
        Date.now(),
        s.welcomeRecentSessionLimit,
      );
      if (recentResult.recentWorkspaces !== s.recentWorkspaces) {
        writeRecentWorkspaces(recentResult.recentWorkspaces);
      }
      return {
        activeTabId: id,
        ...(s.mergeToolWindowRail && tab?.type !== "welcome" ? { sidebarCollapsed: s.sidebarCollapsedByGroup[sidebarRailGroup(tab?.type)] } : {}),
        activeSideTab: tab?.type === "welcome" ? "home" : s.activeSideTab === "home" || s.activeSideTab === "workspaces" || s.activeSideTab === "agents" ? "sessions" : s.activeSideTab,
        recentWorkspaces: recentResult.recentWorkspaces,
        recentWorkspaceIdByWorkspaceInstance: recentResult.recentWorkspaceIdByWorkspaceInstance,
        terminalSplitActive: tab?.type === "terminal" ? s.terminalSplitActive : false,
      };
    }),

  moveTab: (fromId, targetId, position) =>
    set((s) => {
      if (fromId === targetId) return s;
      const from = s.tabs.findIndex((t) => t.id === fromId);
      const target = s.tabs.findIndex((t) => t.id === targetId);
      if (from === -1 || target === -1) return s;

      const next = s.tabs.slice();
      const [moved] = next.splice(from, 1);
      const adjustedTarget = target > from ? target - 1 : target;
      const insertAt = position === "after" ? adjustedTarget + 1 : adjustedTarget;
      next.splice(insertAt, 0, moved);
      if (next.every((t, i) => t === s.tabs[i])) return s;
      return { tabs: next };
    }),

  moveTabToIndex: (id, toIndex) =>
    set((s) => {
      const from = s.tabs.findIndex((t) => t.id === id);
      if (from === -1) return s;
      const clamped = Math.max(0, Math.min(toIndex, s.tabs.length - 1));
      if (from === clamped) return s;
      const next = s.tabs.slice();
      const [moved] = next.splice(from, 1);
      next.splice(clamped, 0, moved);
      return { tabs: next };
    }),

  setTabFilter: (filter) => set({ tabFilter: filter }),
  clearTabFilter: () => set({ tabFilter: null })
});
