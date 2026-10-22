import { useCallback,useEffect,useRef,useState } from "react";
import { type DbTxStatus } from "../../../lib/ipc";
import { supportsManualCommit } from "./queryModel";
import { createApplyTxStatus,createEndTransaction,createRefreshTxStatus,createToggleTxMode } from "./transactionActions";

export interface UseDatabaseTransactionsContext {
  setStatusMessage: (message: string) => void;
  info: import("../../../types").DbConnectInfo;
  connectionSessionId: string | null;
}


export function useDatabaseTransactions(context: UseDatabaseTransactionsContext) {
  const {
    setStatusMessage,
    info,
    connectionSessionId,
  } = context;

  const [txStatus, setTxStatus] = useState<DbTxStatus | null>(null);
  const txStatusRef = useRef<DbTxStatus | null>(null);
  const applyTxStatus = useCallback(createApplyTxStatus({
    txStatusRef,
    setTxStatus,
    setStatusMessage,
  }), [setStatusMessage]);
  const txAvailable = supportsManualCommit(info.engine);

  const refreshTxStatus = useCallback(createRefreshTxStatus({
    connectionSessionId,
    txAvailable,
    applyTxStatus,
  }), [applyTxStatus, connectionSessionId, txAvailable]);

  useEffect(() => {
    applyTxStatus(null);
    void refreshTxStatus();
  }, [applyTxStatus, refreshTxStatus]);

  const toggleTxMode = useCallback(createToggleTxMode({
    txStatusRef,
    connectionSessionId,
    applyTxStatus,
    setStatusMessage,
  }), [applyTxStatus, connectionSessionId, setStatusMessage]);

  const endTransaction = useCallback(
    createEndTransaction({
      connectionSessionId,
      txStatusRef,
      applyTxStatus,
      setStatusMessage,
    }),
    [applyTxStatus, connectionSessionId, setStatusMessage],
  );

  return { txStatusRef, refreshTxStatus, txAvailable, txStatus, toggleTxMode, endTransaction };
}
