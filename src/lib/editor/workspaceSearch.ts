import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface WorkspaceSearchRoot {
  id: string;
  name: string;
  path: string;
}

export interface WorkspaceSearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regexp?: boolean;
  includeGlobs?: string[];
  excludeGlobs?: string[];
  searchIgnored?: boolean;
  maxMatchesPerFile?: number;
  maxTotalMatches?: number;
}

export interface WorkspaceSearchMatch {
  rootId: string;
  rootName: string;
  rootPath: string;
  path: string;
  lineNumber: number;
  column: number;
  matchStart: number;
  matchEnd: number;
  lineText: string;
}

export interface WorkspaceSearchEvent {
  searchId: string;
  kind: "batch" | "done" | "error";
  matches: WorkspaceSearchMatch[];
  truncated: boolean;
  cancelled: boolean;
  filesScanned: number;
  totalMatches: number;
  error: string | null;
}

export function newWorkspaceSearchId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `search-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Subscribe to the result channel for `searchId`. Call this *before*
 * `workspaceSearchStart` — the backend starts emitting batches as soon as the
 * search is started, and Tauri events are not replayed to late listeners.
 */
export function subscribeWorkspaceSearch(
  searchId: string,
  handler: (event: WorkspaceSearchEvent) => void,
): Promise<UnlistenFn> {
  return listen<WorkspaceSearchEvent>(`workspace-search-${searchId}`, (event) => {
    handler(event.payload);
  });
}

export function workspaceSearchStart(
  searchId: string,
  roots: WorkspaceSearchRoot[],
  query: string,
  options?: WorkspaceSearchOptions,
): Promise<string> {
  return invoke<string>("workspace_search_start", {
    searchId,
    roots,
    query,
    options: options ?? null,
  });
}

export function workspaceSearchCancel(searchId: string): Promise<boolean> {
  return invoke<boolean>("workspace_search_cancel", { searchId });
}
