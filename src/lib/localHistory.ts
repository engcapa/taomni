import { invoke } from "@tauri-apps/api/core";

export interface LocalHistoryEntry {
  id: number;
  path: string;
  contentHash: string;
  createdAt: number;
  reason: string;
  byteLen: number;
}

export function historySnapshot(
  path: string,
  text: string,
  reason: string = "save",
): Promise<LocalHistoryEntry | null> {
  return invoke<LocalHistoryEntry | null>("history_snapshot", { path, text, reason });
}

export function historyList(path: string, limit = 50): Promise<LocalHistoryEntry[]> {
  return invoke<LocalHistoryEntry[]>("history_list", { path, limit });
}

export function historyRead(id: number): Promise<string> {
  return invoke<string>("history_read", { id });
}

export function historyPrune(): Promise<number> {
  return invoke<number>("history_prune");
}

export function formatLocalHistoryTime(createdAt: number, now = Date.now()): string {
  const date = new Date(createdAt * 1000);
  const elapsed = Math.max(0, now - date.getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return date.toLocaleString();
}
