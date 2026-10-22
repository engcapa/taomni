import { invoke } from "@tauri-apps/api/core";

// --- Database manual commit ---

/** Session transaction state; `generation` changes when the pool reconnects. */
export interface DbTxStatus {
  supported: boolean;
  manual: boolean;
  pending: number;
  generation: number;
}

export async function dbTxStatus(sessionId: string): Promise<DbTxStatus> {
  return invoke<DbTxStatus>("db_tx_status", { sessionId });
}

export async function dbTxSetManual(sessionId: string, manual: boolean): Promise<DbTxStatus> {
  return invoke<DbTxStatus>("db_tx_set_manual", { sessionId, manual });
}

export async function dbTxCommit(sessionId: string): Promise<DbTxStatus> {
  return invoke<DbTxStatus>("db_tx_commit", { sessionId });
}

export async function dbTxRollback(sessionId: string): Promise<DbTxStatus> {
  return invoke<DbTxStatus>("db_tx_rollback", { sessionId });
}
