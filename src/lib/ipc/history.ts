import { invoke } from "@tauri-apps/api/core";

// --- Command history ────────────────────────────────────────────────

export async function historyAppend(
  hostKey: string,
  command: string,
  max: number,
): Promise<void> {
  return invoke("history_append", { hostKey, command, max });
}

export async function historyMatchPrefix(
  hostKey: string,
  prefix: string,
  limit: number,
): Promise<string[]> {
  return invoke<string[]>("history_match_prefix", { hostKey, prefix, limit });
}

export async function historyListRecent(
  hostKey: string,
  limit: number,
): Promise<string[]> {
  return invoke<string[]>("history_list_recent", { hostKey, limit });
}

export async function historyClear(hostKey: string | null): Promise<void> {
  return invoke("history_clear", { hostKey });
}
