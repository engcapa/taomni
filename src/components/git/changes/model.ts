import { type MouseEvent as ReactMouseEvent } from "react";
import { type GitBlobPair, type GitSnapshot } from "../../../lib/git";
import type { GitWorkspaceRootInfo } from "../../../types";

export type TriState = "all" | "none" | "some";

export interface WorkspaceChangesViewProps {
  roots: GitWorkspaceRootInfo[];
  snapshots: Record<string, {
    snapshot: GitSnapshot | null;
    loading: boolean;
    error: string | null;
  }>;
  busy: boolean;
  treeMode: boolean;
  setTreeMode: (value: boolean) => void;
  checkedKeys: Set<string>;
  checkedCount: number;
  checkedRepoCount: number;
  selectedKeys: Set<string>;
  focusedKey: string | null;
  pair: GitBlobPair | null;
  pairLoading: boolean;
  commitMessage: string;
  setCommitMessage: (message: string) => void;
  canCommitAndPush: boolean;
  scopeSummary: string;
  targetBranch?: string;
  setTargetBranch?: (branch: string) => void;
  branchOptions?: string[];
  branchPlaceholder?: string;
  stageVisible: (pathsByRepo: Record<string, string[]>) => void;
  unstageVisible: (pathsByRepo: Record<string, string[]>) => void;
  stagePaths: (repoRoot: string, paths: string[]) => void;
  unstagePaths: (repoRoot: string, paths: string[]) => void;
  stageSelected: () => void;
  unstageSelected: () => void;
  discardSelected: () => void;
  commit: () => void;
  commitAndPush: () => void;
  onToggleChecked: (repoRoot: string, paths: string[], value: boolean) => void;
  onSelect: (repoRoot: string, path: string, mods: { ctrl: boolean; shift: boolean; }) => void;
  onContextMenu: (repoRoot: string, path: string, event: ReactMouseEvent) => void;
  onNormalizeLineEndings?: () => void;
  normalizeLineEndingsBusy?: boolean;
  onOpenInEditor?: () => void;
  onSaveWorktree?: (text: string) => Promise<void> | void;
  worktreeEditable?: boolean;
}
