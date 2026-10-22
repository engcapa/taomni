import { useEffect, useMemo, useState } from "react";
import { dbConnect, dbDisconnect, dbTxRollback } from "../../../lib/ipc";
import { useAppStore } from "../../../stores/appStore";
import { createDbMetadataCache } from "../../../lib/dbMetadataCache";
import { createRuntimeDbSessionId } from "./persistence";
import { useQueryPanelWorkspace } from "./useQueryPanelWorkspace";

export interface UseDatabaseConnectionContext {
  info: import("../../../types").DbConnectInfo;
  tabId: string;
  txStatusRef: import("react").RefObject<import("../../../lib/ipc").DbTxStatus | null>;
  setStatusMessage: (message: string) => void;
  workspace: ReturnType<typeof useQueryPanelWorkspace>;
}

export function useDatabaseConnection(context: UseDatabaseConnectionContext) {
  const { info, tabId, setStatusMessage } = context;
  const [connectionSessionId, setConnectionSessionId] = useState<string | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const [metadataVersion, setMetadataVersion] = useState(0);
  const setTabDbConn = useAppStore((s) => s.setTabDbConn);
  const setTabDbSelectedObjects = useAppStore((s) => s.setTabDbSelectedObjects);

  const sessionId = info.sessionId;
  const metadataCache = useMemo(
    () =>
      connectionSessionId
        ? createDbMetadataCache({
          sessionId: connectionSessionId,
          defaultCatalog: info.catalog,
        })
        : null,
    [connectionSessionId, info.catalog],
  );

  useEffect(() => {
    if (!metadataCache) return;
    setMetadataVersion((version) => version + 1);
    return metadataCache.subscribe(() => {
      setMetadataVersion((version) => version + 1);
    });
  }, [metadataCache]);

  // Connect on mount, disconnect on unmount.
  useEffect(() => {
    let cancelled = false;
    const runtimeSessionId = createRuntimeDbSessionId(sessionId);
    setConnectionSessionId(null);
    setConnError(null);
    setTabDbSelectedObjects(tabId, null);
    void dbConnect({ ...info, sessionId: runtimeSessionId })
      .then(() => {
        if (cancelled) {
          void dbDisconnect(runtimeSessionId).catch(() => undefined);
          return;
        }
        setConnectionSessionId(runtimeSessionId);
        // Phase 6 — publish the live connection id so the CC DB MCP (when a
        // chat thread is bound to this tab) can target it each turn.
        setTabDbConn(tabId, runtimeSessionId);
      })
      .catch((err) => {
        if (!cancelled) setConnError(String(err));
      });
    return () => {
      cancelled = true;
      // DB-TX-002: roll back uncommitted manual-commit work before closing.
      const tx = context.txStatusRef.current;
      const pending = tx?.manual ? tx.pending : 0;
      const disconnect = () => dbDisconnect(runtimeSessionId).catch(() => undefined);
      if (pending > 0) {
        void dbTxRollback(runtimeSessionId).catch(() => undefined).then(disconnect);
        setStatusMessage(`Rolled back ${pending} uncommitted statement(s) when the database tab closed.`);
      } else {
        void disconnect();
      }
      setTabDbConn(tabId, null);
      setTabDbSelectedObjects(tabId, null);
      Object.values(context.workspace.timersRef.current).forEach(clearInterval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);
  return { connectionSessionId, metadataCache, metadataVersion, setTabDbSelectedObjects, connError };
}
