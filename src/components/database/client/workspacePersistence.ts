import { dbSaveQueryWorkspace, dbSaveSavedQuery, type DbQueryWorkspaceTab, type DbSavedQuery } from "../../../lib/ipc";
import { type SqlEditorHandle } from "../SqlEditorPanel";
import { type PanelState } from "./types";
import { workspaceTabFromPanel } from "./queryModel";
import { writeTextFile } from "./persistence";



export interface PersistWorkspaceSnapshotContext {
  editorHandles: import("react").RefObject<Record<string, SqlEditorHandle | null>>;
  savedQueriesRef: import("react").RefObject<Record<string, DbSavedQuery>>;
  lastAutoSavedDocRef: import("react").RefObject<Record<string, string>>;
  workspaceSessionId: string;
}


export function createPersistWorkspaceSnapshot(controllerContext: PersistWorkspaceSnapshotContext): (sourcePanels: PanelState[], snapshotActivePanelId: string | null) => Promise<{ dirtyUpdates: Record<string, boolean>; savedQueryUpdates: Record<string, DbSavedQuery>; savedQueryErrors: string[]; }> {
  return async (sourcePanels: PanelState[], snapshotActivePanelId: string | null) => {
      const savedAt = Date.now();
      const dirtyUpdates: Record<string, boolean> = {};
      const savedQueryUpdates: Record<string, DbSavedQuery> = {};
      const savedQueryErrors: string[] = [];
      const tabs: DbQueryWorkspaceTab[] = [];
      const panelDocuments = sourcePanels.map((panel) => ({
        panel,
        content: controllerContext.editorHandles.current[panel.id]?.getValue() ?? panel.doc,
      }));

      for (const [index, { panel, content }] of panelDocuments.entries()) {
        let dirty = panel.dirty;
        let savedQuery = controllerContext.savedQueriesRef.current[panel.id] ?? panel.savedQuery;
        if (panel.filePath && controllerContext.lastAutoSavedDocRef.current[panel.id] !== content) {
          await writeTextFile(panel.filePath, content);
          dirty = false;
          dirtyUpdates[panel.id] = false;
        }
        if (savedQuery && savedQuery.content !== content) {
          try {
            savedQuery = await dbSaveSavedQuery({
              ...savedQuery,
              content,
              updatedAt: savedAt,
            });
            controllerContext.savedQueriesRef.current[panel.id] = savedQuery;
            savedQueryUpdates[panel.id] = savedQuery;
            dirty = false;
            dirtyUpdates[panel.id] = false;
          } catch (error) {
            dirty = true;
            dirtyUpdates[panel.id] = true;
            savedQueryErrors.push(`${savedQuery.name}: ${String(error)}`);
          }
        }
        tabs.push(
          workspaceTabFromPanel(
            controllerContext.workspaceSessionId,
            savedQuery === panel.savedQuery ? panel : { ...panel, savedQuery },
            index,
            content,
            savedAt,
            dirty,
          ),
        );
      }

      await dbSaveQueryWorkspace({
        workspaceId: controllerContext.workspaceSessionId,
        activePanelId: snapshotActivePanelId,
        tabs,
        updatedAt: savedAt,
      });
      for (const tab of tabs) {
        controllerContext.lastAutoSavedDocRef.current[tab.panelId] = tab.content;
      }
      return { dirtyUpdates, savedQueryUpdates, savedQueryErrors };
    };
}



export interface AutoSaveWorkspaceContext {
  workspaceReady: boolean;
  autoSaveInFlightRef: import("react").RefObject<Promise<void> | null>;
  panelsRef: import("react").RefObject<PanelState[]>;
  persistWorkspaceSnapshot: (sourcePanels: PanelState[], snapshotActivePanelId: string | null) => Promise<{ dirtyUpdates: Record<string, boolean>; savedQueryUpdates: Record<string, DbSavedQuery>; savedQueryErrors: string[]; }>;
  activePanelIdRef: import("react").RefObject<string>;
  setPanels: import("react").Dispatch<import("react").SetStateAction<PanelState[]>>;
  setStatusMessage: (message: string) => void;
}


export function createAutoSaveWorkspace(controllerContext: AutoSaveWorkspaceContext): () => Promise<void> {
  return async () => {
    if (!controllerContext.workspaceReady) return;
    if (controllerContext.autoSaveInFlightRef.current) return controllerContext.autoSaveInFlightRef.current;
    const save = (async () => {
      try {
        const currentPanels = controllerContext.panelsRef.current;
        const { dirtyUpdates, savedQueryUpdates, savedQueryErrors } =
          await controllerContext.persistWorkspaceSnapshot(currentPanels, controllerContext.activePanelIdRef.current);
        if (Object.keys(dirtyUpdates).length > 0 || Object.keys(savedQueryUpdates).length > 0) {
          controllerContext.setPanels((prev) => {
            const next = prev.map((panel) =>
              dirtyUpdates[panel.id] === undefined && savedQueryUpdates[panel.id] === undefined
                ? panel
                : {
                    ...panel,
                    dirty: dirtyUpdates[panel.id] ?? panel.dirty,
                    savedQuery: savedQueryUpdates[panel.id] ?? panel.savedQuery,
                  },
            );
            controllerContext.panelsRef.current = next;
            return next;
          });
        }
        if (savedQueryErrors.length > 0) {
          controllerContext.setStatusMessage(`Saved query auto-save failed: ${savedQueryErrors.join("; ")}`);
        }
      } catch (err) {
        controllerContext.setStatusMessage(`Query auto-save failed: ${String(err)}`);
      }
    })();
    controllerContext.autoSaveInFlightRef.current = save;
    try {
      await save;
    } finally {
      if (controllerContext.autoSaveInFlightRef.current === save) controllerContext.autoSaveInFlightRef.current = null;
    }
  };
}



export interface ScheduleWorkspaceSaveContext {
  autoSaveDebounceRef: import("react").RefObject<number | null>;
  autoSaveWorkspace: () => Promise<void>;
}


export function createScheduleWorkspaceSave(controllerContext: ScheduleWorkspaceSaveContext): () => void {
  return () => {
    if (controllerContext.autoSaveDebounceRef.current) clearTimeout(controllerContext.autoSaveDebounceRef.current);
    controllerContext.autoSaveDebounceRef.current = setTimeout(() => {
      controllerContext.autoSaveDebounceRef.current = null;
      void controllerContext.autoSaveWorkspace();
    }, 1000);
  };
}
