import { type StateCreator } from "zustand";
import { type AppState } from "./types";
import { readSqlEcho, writeSqlEcho } from "./preferences";
import { dbSelectedObjectsEqual } from "./policies";

export const createDatabaseSlice: StateCreator<AppState, [], [], Pick<AppState, "dbConnByTab" | "dbSelectedObjectsByTab" | "sqlEcho" | "setTabDbConn" | "setTabDbSelectedObjects" | "setSqlEcho">> = (set) => ({
  dbConnByTab: {},
  dbSelectedObjectsByTab: {},
  sqlEcho: readSqlEcho(),

  setTabDbConn: (tabId, connId) =>
    set((s) => {
      if (connId === null) {
        if (!(tabId in s.dbConnByTab)) return s;
        const next = { ...s.dbConnByTab };
        delete next[tabId];
        return { dbConnByTab: next };
      }
      return s.dbConnByTab[tabId] === connId
        ? s
        : { dbConnByTab: { ...s.dbConnByTab, [tabId]: connId } };
    }),

  setTabDbSelectedObjects: (tabId, selected) =>
    set((s) => {
      if (selected === null || selected.length === 0) {
        if (!(tabId in s.dbSelectedObjectsByTab)) return s;
        const next = { ...s.dbSelectedObjectsByTab };
        delete next[tabId];
        return { dbSelectedObjectsByTab: next };
      }
      if (dbSelectedObjectsEqual(s.dbSelectedObjectsByTab[tabId], selected)) {
        return s;
      }
      return {
        dbSelectedObjectsByTab: {
          ...s.dbSelectedObjectsByTab,
          [tabId]: selected,
        },
      };
    }),

  setSqlEcho: (enabled) =>
    set((s) => {
      if (s.sqlEcho === enabled) return s;
      writeSqlEcho(enabled);
      return { sqlEcho: enabled };
    })
});
