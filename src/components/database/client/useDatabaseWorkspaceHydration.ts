import { useEffect } from "react";
import { checkFileExists, dbGetSavedQuery, dbLoadQueryWorkspace, dbSaveQueryWorkspace, type DbSavedQuery } from "../../../lib/ipc";
import { writeDatabaseTabLimit } from "../../../lib/databaseTabLimit";
import { type PanelState } from "./types";
import { newPanel, workspaceTabFromPanel } from "./queryModel";
import { basename, readLegacyWorkspaceCache, readTextFile, writeIntSetting } from "./persistence";


export interface UseDatabaseWorkspaceHydrationContext {
  setWorkspaceReady: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  workspaceSessionId: string;
  tabLimitRef: import("react").RefObject<number>;
  savedQueriesRef: import("react").RefObject<Record<string, DbSavedQuery>>;
  lastAutoSavedDocRef: import("react").RefObject<Record<string, string>>;
  setPanels: import("react").Dispatch<import("react").SetStateAction<PanelState[]>>;
  setActivePanelId: import("react").Dispatch<import("react").SetStateAction<string>>;
  setStatusMessage: (message: string) => void;
  info: import("../../../types").DbConnectInfo;
  rowLimit: number;
  tabLimit: number;
}

export function useDatabaseWorkspaceHydration(context: UseDatabaseWorkspaceHydrationContext) {
  const {
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
  } = context;

  useEffect(() => {
    let cancelled = false;
    setWorkspaceReady(false);
    void (async () => {
      const workspace = await dbLoadQueryWorkspace(workspaceSessionId);
      if (cancelled) return;
      if (workspace) {
        if (workspace.tabs.length === 0) {
          setWorkspaceReady(true);
          return;
        }
        const restored = await Promise.all(
          workspace.tabs.slice(0, tabLimitRef.current).map(async (entry) => {
            const savedQuery = entry.savedQueryId
              ? await dbGetSavedQuery(entry.savedQueryId).catch(() => null)
              : null;
            if (savedQuery) savedQueriesRef.current[entry.panelId] = savedQuery;
            return newPanel({
              id: entry.panelId,
              doc: entry.content,
              filePath: entry.filePath ?? null,
              fileName: entry.fileName ?? (entry.filePath ? basename(entry.filePath) : null),
              savedQuery,
              displayName: entry.displayName ?? null,
              dirty: entry.dirty,
              createdAt: entry.createdAt,
            });
          }),
        );
        lastAutoSavedDocRef.current = Object.fromEntries(
          restored.map((panel) => [panel.id, panel.doc]),
        );
        setPanels(restored);
        setActivePanelId(
          workspace.activePanelId && restored.some((panel) => panel.id === workspace.activePanelId)
            ? workspace.activePanelId
            : restored[0].id,
        );
        setWorkspaceReady(true);
        return;
      }

      const cache = readLegacyWorkspaceCache(workspaceSessionId);
      if (!cache || cache.panels.length === 0) {
        setWorkspaceReady(true);
        return;
      }
      const restored: PanelState[] = [];
      const restoredDocs: Record<string, string> = {};
      for (const [index, entry] of cache.panels.entries()) {
        const path = entry.filePath ?? entry.cachePath;
        if (!path) continue;
        const exists = await checkFileExists(path).catch(() => false);
        if (!exists) continue;
        const doc = await readTextFile(path).catch(() => null);
        if (doc === null) continue;
        restoredDocs[entry.id] = doc;
        restored.push(
          newPanel({
            id: entry.id,
            doc,
            filePath: entry.filePath,
            fileName: entry.filePath ? basename(entry.filePath) : entry.fileName,
            dirty: !entry.filePath,
            createdAt: Date.now() + index,
          }),
        );
        if (restored.length >= tabLimitRef.current) break;
        if (index >= tabLimitRef.current - 1) break;
      }
      if (cancelled) return;
      if (restored.length === 0) {
        setWorkspaceReady(true);
        return;
      }
      const activePanelId =
        cache.activePanelId && restored.some((panel) => panel.id === cache.activePanelId)
          ? cache.activePanelId
          : restored[0].id;
      const importedAt = Date.now();
      await dbSaveQueryWorkspace({
        workspaceId: workspaceSessionId,
        activePanelId,
        tabs: restored.map((panel, index) =>
          workspaceTabFromPanel(
            workspaceSessionId,
            panel,
            index,
            panel.doc,
            importedAt,
          ),
        ),
        updatedAt: importedAt,
      });
      if (cancelled) return;
      lastAutoSavedDocRef.current = restoredDocs;
      setPanels(restored);
      setActivePanelId(activePanelId);
      setWorkspaceReady(true);
    })().catch((err) => {
      if (!cancelled) {
        setStatusMessage(`Query workspace restore failed: ${String(err)}`);
        setWorkspaceReady(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [setStatusMessage, workspaceSessionId]);

  useEffect(() => {
    writeIntSetting(info.engine, "rowLimit", rowLimit);
  }, [info.engine, rowLimit]);

  useEffect(() => {
    writeDatabaseTabLimit(info.engine, tabLimit);
  }, [info.engine, tabLimit]);
  return {};
}
