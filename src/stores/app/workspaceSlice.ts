import { type StateCreator } from "zustand";
import { type AppState } from "./types";
import { initialWelcomeRecentSessionLimit, clampWelcomeRecentSessionLimit, writeWelcomeRecentSessionLimit } from "./preferences";
import { readRecentWorkspaces, writeRecentWorkspaces, upsertRecentWorkspaceList, upsertRecentWorkspaceForTab, shouldRecordRecentWorkspaceContext } from "./recentWorkspaces";
import { arraysEqual, jsonEqual } from "./policies";

export const createWorkspaceSlice: StateCreator<AppState, [], [], Pick<AppState, "codeWorkspaceByTab" | "welcomeRecentSessionLimit" | "recentWorkspaces" | "recentWorkspaceIdByWorkspaceInstance" | "setWelcomeRecentSessionLimit" | "upsertRecentWorkspace" | "recordCodeWorkspaceTab" | "removeRecentWorkspace" | "clearRecentWorkspaces" | "setTabCodeWorkspaceContext">> = (set) => ({
  codeWorkspaceByTab: {},
  welcomeRecentSessionLimit: initialWelcomeRecentSessionLimit,
  recentWorkspaces: readRecentWorkspaces(initialWelcomeRecentSessionLimit),
  recentWorkspaceIdByWorkspaceInstance: {},

  setWelcomeRecentSessionLimit: (limit) =>
    set((s) => {
      const next = clampWelcomeRecentSessionLimit(limit);
      writeWelcomeRecentSessionLimit(next);
      const recentWorkspaces = s.recentWorkspaces.slice(0, next);
      writeRecentWorkspaces(recentWorkspaces);
      return { welcomeRecentSessionLimit: next, recentWorkspaces };
    }),

  upsertRecentWorkspace: (workspace) =>
    set((s) => {
      const recentWorkspaces = upsertRecentWorkspaceList(
        s.recentWorkspaces,
        { ...workspace, lastOpenedAt: workspace.lastOpenedAt || Date.now() },
        s.welcomeRecentSessionLimit,
      );
      writeRecentWorkspaces(recentWorkspaces);
      return { recentWorkspaces };
    }),

  recordCodeWorkspaceTab: (tabId) =>
    set((s) => {
      const tab = s.tabs.find((item) => item.id === tabId);
      const recentResult = upsertRecentWorkspaceForTab(
        s.recentWorkspaces,
        s.recentWorkspaceIdByWorkspaceInstance,
        tab,
        s.codeWorkspaceByTab[tabId],
        Date.now(),
        s.welcomeRecentSessionLimit,
      );
      if (recentResult.recentWorkspaces !== s.recentWorkspaces) {
        writeRecentWorkspaces(recentResult.recentWorkspaces);
      }
      return (
        recentResult.recentWorkspaces === s.recentWorkspaces &&
        recentResult.recentWorkspaceIdByWorkspaceInstance === s.recentWorkspaceIdByWorkspaceInstance
      )
        ? s
        : {
            recentWorkspaces: recentResult.recentWorkspaces,
            recentWorkspaceIdByWorkspaceInstance: recentResult.recentWorkspaceIdByWorkspaceInstance,
          };
    }),

  removeRecentWorkspace: (id) =>
    set((s) => {
      const recentWorkspaces = s.recentWorkspaces.filter((workspace) => workspace.id !== id);
      if (recentWorkspaces.length === s.recentWorkspaces.length) return s;
      writeRecentWorkspaces(recentWorkspaces);
      return { recentWorkspaces };
    }),

  clearRecentWorkspaces: () =>
    set((s) => {
      if (s.recentWorkspaces.length === 0) return s;
      writeRecentWorkspaces([]);
      return { recentWorkspaces: [] };
    }),

  setTabCodeWorkspaceContext: (tabId, context) =>
    set((s) => {
      if (context === null) {
        if (!(tabId in s.codeWorkspaceByTab)) return s;
        const next = { ...s.codeWorkspaceByTab };
        delete next[tabId];
        return { codeWorkspaceByTab: next };
      }
      const current = s.codeWorkspaceByTab[tabId];
      if (
        current &&
        current.repoRoot === context.repoRoot &&
        current.activePath === context.activePath &&
        arraysEqual(current.openPaths, context.openPaths) &&
        arraysEqual(current.dirtyPaths, context.dirtyPaths) &&
        jsonEqual(current.roots, context.roots) &&
        jsonEqual(current.looseFiles, context.looseFiles) &&
        jsonEqual(current.activeFile, context.activeFile) &&
        jsonEqual(current.openFiles, context.openFiles) &&
        jsonEqual(current.dirtyFiles, context.dirtyFiles) &&
        jsonEqual(current.lsp, context.lsp)
      ) {
        return s;
      }
      const tab = s.tabs.find((item) => item.id === tabId);
      const shouldRecordRecent = shouldRecordRecentWorkspaceContext(current, context);
      const recentResult = shouldRecordRecent
        ? upsertRecentWorkspaceForTab(
            s.recentWorkspaces,
            s.recentWorkspaceIdByWorkspaceInstance,
            tab,
            context,
            Date.now(),
            s.welcomeRecentSessionLimit,
          )
        : {
            recentWorkspaces: s.recentWorkspaces,
            recentWorkspaceIdByWorkspaceInstance: s.recentWorkspaceIdByWorkspaceInstance,
          };
      if (recentResult.recentWorkspaces !== s.recentWorkspaces) {
        writeRecentWorkspaces(recentResult.recentWorkspaces);
      }
      return {
        recentWorkspaces: recentResult.recentWorkspaces,
        recentWorkspaceIdByWorkspaceInstance: recentResult.recentWorkspaceIdByWorkspaceInstance,
        codeWorkspaceByTab: {
          ...s.codeWorkspaceByTab,
          [tabId]: context,
        },
      };
    })
});
