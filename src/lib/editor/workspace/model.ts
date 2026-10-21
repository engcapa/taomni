export type WorkspaceEntryType = "file" | "dir" | "symlink" | "other";

export interface WorkspaceEntry {
  name: string;
  path: string;
  fileType: WorkspaceEntryType;
  size: number;
  mtime: number;
  isHidden: boolean;
}

export interface WorkspaceFile {
  path: string;
  text: string;
  /** Backend-decoded text encoding; older browser fixtures may omit it. */
  encoding?: string;
  /** Whether the on-disk UTF-8 bytes begin with EF BB BF. */
  bom?: boolean;
  size: number;
  mtime: number;
  hash: string;
}

export interface WorkspaceCompactChain {
  path: string;
  entries: WorkspaceEntry[];
}

/**
 * Discriminated result every tree IPC crosses the boundary with (W0 §8.20.1).
 * Hooks must never assume an `invoke()` payload contains an array: a missing
 * command, a stub gap, or a malformed backend response decodes to
 * `failed`/`unavailable` here instead of leaking `undefined` into state.
 */
export type WorkspaceTreeLoadResult<T> =
  | { state: "ready"; entries: readonly T[]; truncated: boolean; }
  | { state: "cancelled"; }
  | { state: "unavailable"; reason: string; }
  | { state: "failed"; message: string; };

export interface WorkspaceGitRootCandidate {
  id: string;
  name: string;
  path: string;
}

export interface WorkspaceGitRoot {
  id: string;
  name: string;
  path: string;
  repoRoot: string;
  rootIds: string[];
  isSubmodule?: boolean;
}
