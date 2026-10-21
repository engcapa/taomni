import { useDatabaseWorkspaceHydration } from "./useDatabaseWorkspaceHydration";
import { useCallback, useEffect, useRef, useState } from "react";
import { dbUpdateHistoryTabName, type DbSavedQuery, type DbSqlHistoryEntry } from "../../../lib/ipc";
import { type SqlEditorHandle } from "../SqlEditorPanel";
import { readDatabaseTabLimit } from "../../../lib/databaseTabLimit";
import { type PanelState, type ResultSheet } from "./types";
import { newPanel } from "./queryModel";
import { readIntSetting, DEFAULT_ROW_LIMIT, MIN_ROW_LIMIT, MAX_ROW_LIMIT, MAX_PANEL_NAME_LENGTH, QUERY_AUTO_SAVE_MS } from "./persistence";
import { createPersistWorkspaceSnapshot, createAutoSaveWorkspace, createScheduleWorkspaceSave } from "./workspacePersistence";

export interface UseQueryPanelWorkspaceContext {
  info: import("../../../types").DbConnectInfo;
  workspaceSessionId: string;
  setStatusMessage: (message: string) => void;
  setHistoryEntries: import("react").Dispatch<import("react").SetStateAction<DbSqlHistoryEntry[]>>;
}

export function useQueryPanelWorkspace(context: UseQueryPanelWorkspaceContext) {
  const { info, workspaceSessionId, setStatusMessage, setHistoryEntries } = context;
  const [panels, setPanels] = useState<PanelState[]>(() => [newPanel()]);
  const [activePanelId, setActivePanelId] = useState<string>(() => panels[0].id);
  const [editingPanelId, setEditingPanelId] = useState<string | null>(null);
  const [panelDraftTitle, setPanelDraftTitle] = useState("");
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [rowLimit, setRowLimit] = useState(() =>
    readIntSetting(info.engine, "rowLimit", DEFAULT_ROW_LIMIT, MIN_ROW_LIMIT, MAX_ROW_LIMIT),
  );
  const [tabLimit, setTabLimit] = useState(() => readDatabaseTabLimit(info.engine));
  const historyRef = useRef<Record<string, string[]>>({});
  const editorHandles = useRef<Record<string, SqlEditorHandle | null>>({});
  // Stable "echo target" panel for AI/Claude Code SQL echo (queryRegistry
  // `appendEchoSql`): once chosen it's reused so a whole chat session's SQL
  // accumulates in one editor, instead of scattering across panels.
  const echoPanelIdRef = useRef<string | null>(null);
  const timersRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  /** Set when the user cancels, so the failing statement is logged as cancelled. */
  const cancelRequestedRef = useRef<Record<string, boolean>>({});
  const panelsRef = useRef<PanelState[]>(panels);
  const tabLimitRef = useRef(tabLimit);
  const activePanelIdRef = useRef(activePanelId);
  const autoSaveInFlightRef = useRef<Promise<void> | null>(null);
  const autoSaveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRenameCancelRef = useRef(false);
  const lastAutoSavedDocRef = useRef<Record<string, string>>({});
  const savedQueriesRef = useRef<Record<string, DbSavedQuery>>({});

  useEffect(() => {
    panelsRef.current = panels;
  }, [panels]);

  useEffect(() => {
    tabLimitRef.current = tabLimit;
  }, [tabLimit]);

  useEffect(() => {
    activePanelIdRef.current = activePanelId;
  }, [activePanelId]);
  useDatabaseWorkspaceHydration({
    setWorkspaceReady,
    workspaceSessionId,
    tabLimitRef,
    savedQueriesRef,
    lastAutoSavedDocRef,
    setPanels,
    setActivePanelId,
    setStatusMessage,
    info,
    rowLimit,
    tabLimit,
  });

  const patchPanel = useCallback((id: string, patch: Partial<PanelState>) => {
    setPanels((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  const updatePanel = useCallback((id: string, updater: (panel: PanelState) => PanelState) => {
    setPanels((prev) => prev.map((p) => (p.id === id ? updater(p) : p)));
  }, []);

  const patchSheet = useCallback((panelId: string, sheetId: string, patch: Partial<ResultSheet>) => {
    updatePanel(panelId, (panel) => ({
      ...panel,
      sheets: panel.sheets.map((sheet) => (sheet.id === sheetId ? { ...sheet, ...patch } : sheet)),
    }));
  }, [updatePanel]);

  const updateSheet = useCallback(
    (panelId: string, sheetId: string, updater: (sheet: ResultSheet) => ResultSheet) => {
      updatePanel(panelId, (panel) => ({
        ...panel,
        sheets: panel.sheets.map((sheet) => (sheet.id === sheetId ? updater(sheet) : sheet)),
      }));
    },
    [updatePanel],
  );

  const persistWorkspaceSnapshot = useCallback(
    createPersistWorkspaceSnapshot({
      editorHandles,
      savedQueriesRef,
      lastAutoSavedDocRef,
      workspaceSessionId,
    }),
    [workspaceSessionId],
  );

  const autoSaveWorkspace = useCallback(createAutoSaveWorkspace({
    workspaceReady,
    autoSaveInFlightRef,
    panelsRef,
    persistWorkspaceSnapshot,
    activePanelIdRef,
    setPanels,
    setStatusMessage,
  }), [persistWorkspaceSnapshot, setStatusMessage, workspaceReady]);

  const flushWorkspace = useCallback(async () => {
    await autoSaveWorkspace();
    await autoSaveWorkspace();
  }, [autoSaveWorkspace]);

  const scheduleWorkspaceSave = useCallback(createScheduleWorkspaceSave({
    autoSaveDebounceRef,
    autoSaveWorkspace,
  }), [autoSaveWorkspace]);

  const panelDerivedLabel = useCallback((panel: PanelState) => {
    const index = panelsRef.current.findIndex((candidate) => candidate.id === panel.id);
    return panel.fileName ?? panel.savedQuery?.name ?? `Query ${(index < 0 ? 0 : index) + 1}`;
  }, []);

  const startPanelRename = (panel: PanelState) => {
    panelRenameCancelRef.current = false;
    setActivePanelId(panel.id);
    setPanelDraftTitle(panel.displayName ?? panelDerivedLabel(panel));
    setEditingPanelId(panel.id);
  };

  const cancelPanelRename = () => {
    panelRenameCancelRef.current = true;
    setEditingPanelId(null);
    setPanelDraftTitle("");
  };

  const commitPanelRename = (panelId: string, value?: string) => {
    if (panelRenameCancelRef.current) {
      panelRenameCancelRef.current = false;
      setEditingPanelId(null);
      setPanelDraftTitle("");
      return;
    }
    const draft = value ?? panelDraftTitle;
    setEditingPanelId(null);
    setPanelDraftTitle("");
    const panel = panelsRef.current.find((candidate) => candidate.id === panelId);
    if (!panel) return;
    const normalized = draft.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_PANEL_NAME_LENGTH);
    const nextName = !normalized || normalized === panelDerivedLabel(panel) ? null : normalized;
    const previous = panel.displayName ?? null;
    if (nextName === previous) return;
    patchPanel(panelId, { displayName: nextName });
    setHistoryEntries((prev) =>
      prev.map((entry) =>
        entry.panelId === panelId && entry.savedSessionId === workspaceSessionId
          ? { ...entry, tabName: nextName }
          : entry,
      ),
    );
    scheduleWorkspaceSave();
    void dbUpdateHistoryTabName(workspaceSessionId, panelId, nextName).catch((err) => {
      setStatusMessage(`History tab name update failed: ${String(err)}`);
    });
  };

  useEffect(() => {
    const timer = setInterval(() => {
      void autoSaveWorkspace();
    }, QUERY_AUTO_SAVE_MS);
    return () => {
      clearInterval(timer);
      if (autoSaveDebounceRef.current) {
        clearTimeout(autoSaveDebounceRef.current);
        autoSaveDebounceRef.current = null;
      }
      void flushWorkspace();
    };
  }, [autoSaveWorkspace, flushWorkspace]);
  return { timersRef, panels, patchSheet, updateSheet, panelsRef, historyRef, setPanels, cancelRequestedRef, rowLimit, tabLimit, setActivePanelId, activePanelId, editorHandles, patchPanel, echoPanelIdRef, activePanelIdRef, flushWorkspace, lastAutoSavedDocRef, savedQueriesRef, persistWorkspaceSnapshot, startPanelRename, scheduleWorkspaceSave, workspaceReady, editingPanelId, panelDraftTitle, setPanelDraftTitle, commitPanelRename, cancelPanelRename, setRowLimit, setTabLimit };
}
