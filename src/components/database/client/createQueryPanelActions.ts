import { dbCancel, dbCloseQueryWorkspaceTabs, type DbSavedQuery } from "../../../lib/ipc";
import { type SqlEditorHandle } from "../SqlEditorPanel";
import { type PanelState } from "./types";
import { newPanel } from "./queryModel";


export interface CreateQueryPanelActionsContext {
  panels: PanelState[];
  tabLimit: number;
  setPanels: import("react").Dispatch<import("react").SetStateAction<PanelState[]>>;
  setActivePanelId: import("react").Dispatch<import("react").SetStateAction<string>>;
  connectionSessionId: string | null;
  timersRef: import("react").RefObject<Record<string, number>>;
  editorHandles: import("react").RefObject<Record<string, SqlEditorHandle | null>>;
  historyRef: import("react").RefObject<Record<string, string[]>>;
  lastAutoSavedDocRef: import("react").RefObject<Record<string, string>>;
  savedQueriesRef: import("react").RefObject<Record<string, DbSavedQuery>>;
  activePanelId: string;
  persistWorkspaceSnapshot: (sourcePanels: PanelState[], snapshotActivePanelId: string | null) => Promise<{ dirtyUpdates: Record<string, boolean>; savedQueryUpdates: Record<string, DbSavedQuery>; savedQueryErrors: string[]; }>;
  workspaceSessionId: string;
  setStatusMessage: (message: string) => void;
  panelsRef: import("react").RefObject<PanelState[]>;
}

export function createQueryPanelActions(context: CreateQueryPanelActionsContext) {
  const {
    panels,
    tabLimit,
    setPanels,
    setActivePanelId,
    connectionSessionId,
    timersRef,
    editorHandles,
    historyRef,
    lastAutoSavedDocRef,
    savedQueriesRef,
    activePanelId,
    persistWorkspaceSnapshot,
    workspaceSessionId,
    setStatusMessage,
    panelsRef,
  } = context;

  const addPanel = () => {
    if (panels.length >= tabLimit) return;
    const p = newPanel();
    setPanels((prev) => [...prev, p]);
    setActivePanelId(p.id);
  };

  const cleanupClosedPanels = (closingPanels: PanelState[]) => {
    if (closingPanels.some((panel) => panel.sheets.some((sheet) => sheet.running))) {
      if (connectionSessionId) {
        void dbCancel(connectionSessionId).catch(() => undefined);
      }
    }
    closingPanels.forEach((panel) => {
      panel.sheets.forEach((sheet) => {
        if (timersRef.current[sheet.id]) {
          clearInterval(timersRef.current[sheet.id]);
          delete timersRef.current[sheet.id];
        }
      });
      delete editorHandles.current[panel.id];
      delete historyRef.current[panel.id];
      delete lastAutoSavedDocRef.current[panel.id];
      delete savedQueriesRef.current[panel.id];
    });
  };

  const closePanel = async (id: string) => {
    if (panels.length <= 1) return;
    const closing = panels.find((p) => p.id === id);
    if (!closing) return;
    const next = panels.filter((p) => p.id !== id);
    const nextActivePanelId = activePanelId === id ? next[0].id : activePanelId;
    try {
      await persistWorkspaceSnapshot(panels, activePanelId);
      await dbCloseQueryWorkspaceTabs(workspaceSessionId, [id], Date.now());
    } catch (err) {
      setStatusMessage(`Query tab close failed: ${String(err)}`);
      return;
    }
    cleanupClosedPanels([closing]);
    panelsRef.current = next;
    setPanels(next);
    if (activePanelId === id) setActivePanelId(nextActivePanelId);
    void persistWorkspaceSnapshot(next, nextActivePanelId).catch((err) => {
      setStatusMessage(`Query workspace save failed: ${String(err)}`);
    });
  };

  const closeOtherPanels = async (id: string) => {
    const target = panels.find((p) => p.id === id);
    if (!target || panels.length <= 1) return;
    const closing = panels.filter((p) => p.id !== id);
    try {
      await persistWorkspaceSnapshot(panels, activePanelId);
      await dbCloseQueryWorkspaceTabs(
        workspaceSessionId,
        closing.map((panel) => panel.id),
        Date.now(),
      );
    } catch (err) {
      setStatusMessage(`Query tabs close failed: ${String(err)}`);
      return;
    }
    cleanupClosedPanels(closing);
    panelsRef.current = [target];
    setPanels([target]);
    setActivePanelId(id);
    void persistWorkspaceSnapshot([target], id).catch((err) => {
      setStatusMessage(`Query workspace save failed: ${String(err)}`);
    });
  };

  const closeAllPanels = async () => {
    try {
      await persistWorkspaceSnapshot(panels, activePanelId);
      await dbCloseQueryWorkspaceTabs(
        workspaceSessionId,
        panels.map((panel) => panel.id),
        Date.now(),
      );
    } catch (err) {
      setStatusMessage(`Query tabs close failed: ${String(err)}`);
      return;
    }
    cleanupClosedPanels(panels);
    const p = newPanel();
    panelsRef.current = [p];
    setPanels([p]);
    setActivePanelId(p.id);
    void persistWorkspaceSnapshot([p], p.id).catch((err) => {
      setStatusMessage(`Query workspace save failed: ${String(err)}`);
    });
  };
  return { addPanel, closePanel, closeOtherPanels, closeAllPanels };
}
