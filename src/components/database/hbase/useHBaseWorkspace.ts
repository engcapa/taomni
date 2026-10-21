import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readDatabaseTabLimit, writeDatabaseTabLimit } from "../../../lib/databaseTabLimit";
import { dbGetSavedQuery, dbSaveSavedQuery, type DbSavedQuery } from "../../../lib/ipc";
import type { HBaseConnectInfo } from "../../../types";
import { type SqlEditorHandle } from "../SqlEditorPanel";
import { HBASE_TAB_LIMIT_SCOPE, newPanel, type PanelState, type ResultSheet } from "./model";

export interface UseHBaseWorkspaceContext {
  info: HBaseConnectInfo;
  setStatusMessage: (message: string) => void;
}

export function useHBaseWorkspace(context: UseHBaseWorkspaceContext) {
  const { info, setStatusMessage } = context;
  const [tabLimit, setTabLimit] = useState(() => readDatabaseTabLimit(HBASE_TAB_LIMIT_SCOPE));

  // --- workspace state (restored from localStorage) ---
  const workspaceKey = `taomni.hbase.workspace.v1.${info.sessionId}`;
  const [panels, setPanels] = useState<PanelState[]>(() => {
    try {
      const raw = localStorage.getItem(workspaceKey);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          docs?: string[];
          panels?: Array<{ doc?: string; savedQueryId?: string | null; }>;
        };
        if (Array.isArray(parsed.panels) && parsed.panels.length > 0) {
          return parsed.panels.slice(0, tabLimit).map((panel) => ({
            ...newPanel(typeof panel.doc === "string" ? panel.doc : ""),
            savedQueryId: panel.savedQueryId ?? null,
          }));
        }
        if (Array.isArray(parsed.docs) && parsed.docs.length > 0) {
          return parsed.docs.slice(0, tabLimit).map((doc) => newPanel(doc));
        }
      }
    } catch {
      /* ignore */
    }
    return [newPanel("list")];
  });
  const [activePanelId, setActivePanelId] = useState<string>(() => panels[0]?.id ?? "");

  const editorHandles = useRef<Record<string, SqlEditorHandle | null>>({});
  const panelsRef = useRef(panels);
  const savedQueryFlushRef = useRef<Promise<void> | null>(null);

  const activePanel = useMemo(
    () => panels.find((p) => p.id === activePanelId) ?? panels[0],
    [panels, activePanelId],
  );

  useEffect(() => {
    panelsRef.current = panels;
  }, [panels]);

  useEffect(() => {
    writeDatabaseTabLimit(HBASE_TAB_LIMIT_SCOPE, tabLimit);
  }, [tabLimit]);

  // Persist panel docs + active panel for restore-on-mount.
  useEffect(() => {
    try {
      localStorage.setItem(workspaceKey, JSON.stringify({
        panels: panels.map((panel) => ({
          doc: panel.doc,
          savedQueryId: panel.savedQueryId,
        })),
      }));
    } catch {
      /* ignore quota */
    }
  }, [panels, workspaceKey]);

  useEffect(() => {
    let cancelled = false;
    const linkedPanels = panels.filter((panel) => panel.savedQueryId && !panel.savedQuery);
    if (linkedPanels.length === 0) return;
    void Promise.all(
      linkedPanels.map(async (panel) => ({
        panelId: panel.id,
        query: panel.savedQueryId
          ? await dbGetSavedQuery(panel.savedQueryId).catch(() => null)
          : null,
      })),
    ).then((loaded) => {
      if (cancelled) return;
      setPanels((current) => current.map((panel) => {
        const match = loaded.find((item) => item.panelId === panel.id)?.query;
        return match ? { ...panel, savedQueryId: match.id, savedQuery: match } : panel;
      }));
    });
    return () => {
      cancelled = true;
    };
    // Query links are loaded from the initial workspace snapshot once per stable session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceKey]);

  // --- state patch helpers ---
  const patchPanel = useCallback((id: string, patch: Partial<PanelState>) => {
    setPanels((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);
  const patchSheet = useCallback((panelId: string, sheetId: string, patch: Partial<ResultSheet>) => {
    setPanels((prev) =>
      prev.map((p) =>
        p.id !== panelId ? p : { ...p, sheets: p.sheets.map((s) => (s.id === sheetId ? { ...s, ...patch } : s)) },
      ),
    );
  }, []);

  const addPanel = useCallback(
    (doc = "", savedQuery: DbSavedQuery | null = null) => {
      if (panels.length >= tabLimit) return null;
      const panel = newPanel(doc, savedQuery);
      setPanels((prev) => [...prev, panel]);
      setActivePanelId(panel.id);
      return panel.id;
    },
    [panels.length, tabLimit],
  );

  const flushSavedQueries = useCallback(async () => {
    if (savedQueryFlushRef.current) return savedQueryFlushRef.current;
    const save = (async () => {
      const updates = new Map<string, DbSavedQuery>();
      const errors: string[] = [];
      for (const panel of panelsRef.current) {
        const query = panel.savedQuery;
        const content = editorHandles.current[panel.id]?.getValue() ?? panel.doc;
        if (!query || query.content === content) continue;
        try {
          updates.set(panel.id, await dbSaveSavedQuery({
            ...query,
            content,
            updatedAt: Date.now(),
          }));
        } catch (error) {
          errors.push(`${query.name}: ${String(error)}`);
        }
      }
      if (updates.size > 0) {
        setPanels((current) => {
          const next = current.map((panel) => {
            const query = updates.get(panel.id);
            return query
              ? { ...panel, doc: query.content, savedQueryId: query.id, savedQuery: query }
              : panel;
          });
          panelsRef.current = next;
          return next;
        });
      }
      if (errors.length > 0) {
        setStatusMessage(`HBase saved query auto-save failed: ${errors.join("; ")}`);
      }
    })();
    savedQueryFlushRef.current = save;
    try {
      await save;
    } finally {
      if (savedQueryFlushRef.current === save) savedQueryFlushRef.current = null;
    }
  }, [setStatusMessage]);

  useEffect(() => {
    const hasChanges = panels.some((panel) => {
      const content = editorHandles.current[panel.id]?.getValue() ?? panel.doc;
      return panel.savedQuery && panel.savedQuery.content !== content;
    });
    if (!hasChanges) return;
    const timer = setTimeout(() => void flushSavedQueries(), 2000);
    return () => clearTimeout(timer);
  }, [flushSavedQueries, panels]);

  useEffect(() => () => {
    void flushSavedQueries();
  }, [flushSavedQueries]);

  const closePanel = useCallback(
    (panelId: string) => {
      setPanels((prev) => {
        if (prev.length <= 1) return prev;
        const next = prev.filter((p) => p.id !== panelId);
        if (panelId === activePanelId) setActivePanelId(next[next.length - 1].id);
        return next;
      });
    },
    [activePanelId],
  );
  return {
    panels,
    patchSheet,
    setPanels,
    tabLimit,
    editorHandles,
    setActivePanelId,
    activePanel,
    activePanelId,
    patchPanel,
    addPanel,
    panelsRef,
    flushSavedQueries,
    closePanel,
    setTabLimit,
  };
}
