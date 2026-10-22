import type { GitBlobPair } from "../../../lib/git";


export type ViewMode = "split" | "unified";


export interface DiffViewerProps {
  pair: GitBlobPair | null;
  loading?: boolean;
  emptyLabel?: string;
  /** When set, shown for EOL-only pairs so the user can rewrite the worktree. */
  onNormalizeLineEndings?: () => void;
  normalizeLineEndingsBusy?: boolean;
  /** P2: allow editing the worktree (new) side of the diff. */
  worktreeEditable?: boolean;
  onSaveWorktree?: (text: string) => Promise<void> | void;
  /** Repository that produced `pair`; exposed as `data-repo-root` so callers can prove diff identity. */
  repoRoot?: string | null;
}

export const VIEW_KEY = "taomni.git.diff.view";

export const WS_KEY = "taomni.git.diff.ws";

export const SYNC_SCROLL_KEY = "taomni.git.diff.syncScroll";


export function readPref<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T) || fallback;
  } catch {
    return fallback;
  }
}


export function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}
