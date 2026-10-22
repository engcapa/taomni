import { type WorkspaceCompactChain, type WorkspaceEntry, type WorkspaceEntryType, type WorkspaceTreeLoadResult } from "./model";

export const WORKSPACE_ENTRY_TYPES: readonly WorkspaceEntryType[] = ["file", "dir", "symlink", "other"];

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isWorkspaceEntry(value: unknown): value is WorkspaceEntry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.path === "string" &&
    WORKSPACE_ENTRY_TYPES.includes(candidate.fileType as WorkspaceEntryType) &&
    typeof candidate.size === "number" &&
    Number.isFinite(candidate.size) &&
    typeof candidate.mtime === "number" &&
    Number.isFinite(candidate.mtime) &&
    typeof candidate.isHidden === "boolean"
  );
}

export function decodeWorkspaceEntries(
  value: unknown,
  command: string,
  maxFiles?: number | null,
): WorkspaceTreeLoadResult<WorkspaceEntry> {
  if (value === undefined || value === null) {
    return { state: "failed", message: `${command} returned no payload` };
  }
  if (!Array.isArray(value)) {
    return {
      state: "failed",
      message: `${command}: expected an array, got ${typeof value}`,
    };
  }
  const entries: WorkspaceEntry[] = [];
  for (const item of value) {
    if (!isWorkspaceEntry(item)) {
      return {
        state: "failed",
        message: `${command}: malformed entry at index ${entries.length}`,
      };
    }
    entries.push(item);
  }
  return {
    state: "ready",
    entries,
    truncated: maxFiles != null && entries.length >= maxFiles,
  };
}

export function decodeWorkspaceCompactChain(
  value: unknown,
  command: string,
): WorkspaceTreeLoadResult<WorkspaceEntry> {
  if (value === undefined || value === null) {
    return { state: "failed", message: `${command} returned no payload` };
  }
  if (typeof value !== "object" || typeof (value as WorkspaceCompactChain).path !== "string") {
    return { state: "failed", message: `${command}: malformed chain payload` };
  }
  const chain = value as WorkspaceCompactChain;
  if (!Array.isArray(chain.entries)) {
    return { state: "failed", message: `${command}: chain entries is not an array` };
  }
  for (const item of chain.entries) {
    if (!isWorkspaceEntry(item)) {
      return { state: "failed", message: `${command}: malformed chain entry` };
    }
  }
  return { state: "ready", entries: chain.entries, truncated: false };
}
