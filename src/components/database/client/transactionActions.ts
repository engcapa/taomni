import { dbExecute, dbTxCommit, dbTxRollback, dbTxSetManual, dbTxStatus, dbDescribeTable, type DbColumnDescription, type DbTxStatus } from "../../../lib/ipc";
import { type QueryGridCommitPayload, type QueryRefreshMode } from "../QueryResultGrid";
import { alertAppDialog, confirmAppDialog } from "../../../lib/appDialogs";
import { buildGridChangeStatements } from "../../../lib/dbGridChanges";
import { type PanelState } from "./types";
import { parseEditableSelectTarget, qualifiedName } from "./queryModel";


export interface ApplyTxStatusContext {
  txStatusRef: import("react").RefObject<DbTxStatus | null>;
  setTxStatus: import("react").Dispatch<import("react").SetStateAction<DbTxStatus | null>>;
  setStatusMessage: (message: string) => void;
}


export function createApplyTxStatus(controllerContext: ApplyTxStatusContext): (next: DbTxStatus | null) => void {
  return (next: DbTxStatus | null) => {
    const previous = controllerContext.txStatusRef.current;
    controllerContext.txStatusRef.current = next;
    controllerContext.setTxStatus(next);
    // DB-TX-002: a new physical connection drops the open transaction.
    if (previous?.manual && previous.pending > 0 && next && next.generation > previous.generation) {
      const message = `The database connection was re-established. ${previous.pending} uncommitted statement(s) were lost.`;
      controllerContext.setStatusMessage(message);
      void alertAppDialog({ title: "Connection re-established", message });
    }
  };
}



export interface RefreshTxStatusContext {
  connectionSessionId: string | null;
  txAvailable: boolean;
  applyTxStatus: (next: DbTxStatus | null) => void;
}


export function createRefreshTxStatus(controllerContext: RefreshTxStatusContext): () => Promise<void> {
  return async () => {
    if (!controllerContext.connectionSessionId || !controllerContext.txAvailable) return;
    try {
      controllerContext.applyTxStatus(await dbTxStatus(controllerContext.connectionSessionId));
    } catch {
      // Status is advisory; the next statement refreshes it again.
    }
  };
}



export interface ToggleTxModeContext {
  txStatusRef: import("react").RefObject<DbTxStatus | null>;
  connectionSessionId: string | null;
  applyTxStatus: (next: DbTxStatus | null) => void;
  setStatusMessage: (message: string) => void;
}


export function createToggleTxMode(controllerContext: ToggleTxModeContext): () => Promise<void> {
  return async () => {
    const current = controllerContext.txStatusRef.current;
    if (!controllerContext.connectionSessionId || !current?.supported) return;
    const manual = !current.manual;
    if (!manual && current.pending > 0) {
      const confirmed = await confirmAppDialog({
        title: "Switch to auto-commit",
        message: `${current.pending} pending statement(s) will be committed.`,
        confirmLabel: "Commit and switch",
      });
      if (!confirmed) return;
    }
    try {
      controllerContext.applyTxStatus(await dbTxSetManual(controllerContext.connectionSessionId, manual));
      controllerContext.setStatusMessage(manual ? "Manual commit: changes stay pending until Commit." : "Auto-commit enabled.");
    } catch (err) {
      controllerContext.setStatusMessage(`Transaction mode change failed: ${String(err)}`);
    }
  };
}



export interface EndTransactionContext {
  connectionSessionId: string | null;
  txStatusRef: import("react").RefObject<DbTxStatus | null>;
  applyTxStatus: (next: DbTxStatus | null) => void;
  setStatusMessage: (message: string) => void;
}


export function createEndTransaction(controllerContext: EndTransactionContext): (commit: boolean) => Promise<void> {
  return async (commit: boolean) => {
      if (!controllerContext.connectionSessionId) return;
      const pending = controllerContext.txStatusRef.current?.pending ?? 0;
      try {
        controllerContext.applyTxStatus(await (commit ? dbTxCommit : dbTxRollback)(controllerContext.connectionSessionId));
        controllerContext.setStatusMessage(`${commit ? "Committed" : "Rolled back"} ${pending} pending statement(s).`);
      } catch (err) {
        controllerContext.setStatusMessage(`${commit ? "Commit" : "Rollback"} failed: ${String(err)}`);
      }
    };
}



export interface PrepareGridChangesContext {
  panelsRef: import("react").RefObject<PanelState[]>;
  activeSchema: string | null;
  info: import("../../../types").DbConnectInfo;
  connectionSessionId: string | null;
  metadataCache: import("../../../lib/dbMetadataCache").DbMetadataCache | null;
}


export function createPrepareGridChanges(controllerContext: PrepareGridChangesContext): (panelId: string, sheetId: string, payload: QueryGridCommitPayload) => Promise<import("../../../lib/dbGridChanges").GridChangeStatements> {
  return async (panelId: string, sheetId: string, payload: QueryGridCommitPayload) => {
      const panel = controllerContext.panelsRef.current.find((p) => p.id === panelId);
      const sheet = panel?.sheets.find((candidate) => candidate.id === sheetId);
      if (!panel || !sheet) throw new Error("Result sheet is no longer available.");
      const target = parseEditableSelectTarget(sheet.sql);
      if (!target) {
        throw new Error("Grid write-back supports simple SELECT ... FROM table result sheets only.");
      }
      const schema = target.schema ?? controllerContext.activeSchema;
      const tableName = qualifiedName(controllerContext.info.engine, schema, target.table, controllerContext.info.catalog);
      let described: DbColumnDescription[] = [];
      try {
        if (!controllerContext.connectionSessionId) throw new Error("Database connection is still starting.");
        described = controllerContext.metadataCache
          ? await controllerContext.metadataCache.describeTable(schema, target.table, controllerContext.info.catalog)
          : await dbDescribeTable(controllerContext.connectionSessionId, schema, target.table, controllerContext.info.catalog);
      } catch {
        described = [];
      }
      return buildGridChangeStatements({
        engine: controllerContext.info.engine,
        tableName,
        columns: payload.columns.map((column) => column.name),
        primaryKeys: described.filter((column) => column.primaryKey).map((column) => column.name),
        changes: payload.changes,
      });
    };
}



export interface CommitGridChangesContext {
  prepareGridChanges: (panelId: string, sheetId: string, payload: QueryGridCommitPayload) => Promise<import("../../../lib/dbGridChanges").GridChangeStatements>;
  connectionSessionId: string | null;
  txStatusRef: import("react").RefObject<DbTxStatus | null>;
  refreshTxStatus: () => Promise<void>;
  setStatusMessage: (message: string) => void;
  refreshSheet: (panelId: string, sheetId: string, mode: QueryRefreshMode, sqlOverride?: string) => Promise<void>;
}


export function createCommitGridChanges(controllerContext: CommitGridChangesContext): (panelId: string, sheetId: string, payload: QueryGridCommitPayload) => Promise<void> {
  return async (panelId: string, sheetId: string, payload: QueryGridCommitPayload) => {
      const { statements } = await controllerContext.prepareGridChanges(panelId, sheetId, payload);
      if (statements.length === 0) return;
      for (const sql of statements) {
        if (!controllerContext.connectionSessionId) throw new Error("Database connection is still starting.");
        await dbExecute(controllerContext.connectionSessionId, sql);
      }
      if (controllerContext.txStatusRef.current?.manual) await controllerContext.refreshTxStatus();
      controllerContext.setStatusMessage(
        `Submitted grid changes: ${payload.counts.inserted} added, ${payload.counts.updated} modified, ${payload.counts.deleted} deleted.`,
      );
      await controllerContext.refreshSheet(panelId, sheetId, "clearView");
    };
}
