import { useCallback } from "react";
import { type QueryGridCommitPayload } from "../QueryResultGrid";
import { gridChangePreview, type GridChangePreview } from "../../../lib/dbGridChanges";
import { type PanelState } from "./types";
import { createPrepareGridChanges, createCommitGridChanges } from "./transactionActions";


export interface UseDatabaseGridChangesContext {
  panelsRef: import("react").RefObject<PanelState[]>;
  activeSchema: string | null;
  info: import("../../../types").DbConnectInfo;
  connectionSessionId: string | null;
  metadataCache: import("../../../lib/dbMetadataCache").DbMetadataCache | null;
  txStatusRef: import("react").RefObject<import("../../../lib/ipc").DbTxStatus | null>;
  refreshTxStatus: () => Promise<void>;
  setStatusMessage: (message: string) => void;
  refreshSheet: (panelId: string, sheetId: string, mode: import("../QueryResultGrid").QueryRefreshMode, sqlOverride?: string) => Promise<void>;
}

export function useDatabaseGridChanges(context: UseDatabaseGridChangesContext) {
  const { panelsRef, activeSchema, info, connectionSessionId, metadataCache, txStatusRef, refreshTxStatus, setStatusMessage, refreshSheet } = context;

  /** Generate the DML for grid edits so it can be previewed, then executed. */
  const prepareGridChanges = useCallback(
    createPrepareGridChanges({
      panelsRef,
      activeSchema,
      info,
      connectionSessionId,
      metadataCache,
    }),
    [activeSchema, connectionSessionId, info.catalog, info.engine, metadataCache],
  );

  const previewGridChanges = useCallback(
    async (panelId: string, sheetId: string, payload: QueryGridCommitPayload): Promise<GridChangePreview> =>
      gridChangePreview(await prepareGridChanges(panelId, sheetId, payload)),
    [prepareGridChanges],
  );

  const commitGridChanges = useCallback(
    createCommitGridChanges({
      prepareGridChanges,
      connectionSessionId,
      txStatusRef,
      refreshTxStatus,
      setStatusMessage,
      refreshSheet,
    }),
    [connectionSessionId, prepareGridChanges, refreshSheet, refreshTxStatus, setStatusMessage],
  );
  return { commitGridChanges, previewGridChanges };
}
