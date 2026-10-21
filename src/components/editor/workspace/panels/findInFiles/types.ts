import type { LspWorkspaceEdit } from "../../../../../lib/editor/lsp";
import { type WorkspaceSearchMatch } from "../../../../../lib/editor/workspaceSearch";
import type { CodeWorkspaceRootInfo } from "../../../../../types";
import { type ReplaceFilePreimage, type ReplacePrepareOptions, type ReplacePreviewSnapshot } from "../../replaceInFilesModel";

export interface FindInFilesPanelProps {
  roots: CodeWorkspaceRootInfo[];
  onOpenMatch: (match: WorkspaceSearchMatch, options: { preview: boolean; }) => void;
  /** Commit a filtered replace transaction; returns the commit report. */
  onReplaceMatches?: (
    matches: WorkspaceSearchMatch[],
    replacement: string,
    edit: LspWorkspaceEdit,
    snapshot: ReplacePreviewSnapshot,
  ) => Promise<{ ok: boolean; appliedCount?: number; fileCount?: number; message?: string; }>;
  /**
   * ED-MAIN-005 / ED-REPAIR-005: read the frozen per-file preimage before the preview can be
   * confirmed. Returns the preimages for the given absolute paths with request identity options.
   */
  onPrepareReplacePreimages?: (
    paths: readonly string[],
    options?: ReplacePrepareOptions,
  ) => Promise<readonly ReplaceFilePreimage[]>;
  /** Bump to move focus into the query input (Ctrl+Shift+F). */
  focusNonce?: number;
  /** When opening from Replace in Files, prefer the replacement field when query is present. */
  focusTarget?: "query" | "replace";
  /** Bump the nonce to overwrite the include globs ("Find in Directory..."). */
  includePreset?: { value: string; nonce: number; };
  /** Bump the nonce to seed the query field (Search Everywhere Text tab). */
  queryPreset?: { value: string; nonce: number; };
  /** Workspace instance id for search history persistence. */
  workspaceInstanceId?: string;
}

export interface MatchGroup {
  key: string;
  title: string;
  matches: WorkspaceSearchMatch[];
}

export interface SearchSummary {
  filesScanned: number;
  totalMatches: number;
  truncated: boolean;
  cancelled: boolean;
}

export type SearchStatus = "idle" | "searching" | "done" | "error";

export interface MatchSegments {
  before: string;
  hit: string;
  after: string;
  /** Display text without ellipsis markers (code points in the kept window). */
  text: string;
  /** Hit range within `text` (code-point indices). */
  hitStart: number;
  hitEnd: number;
  elidedStart: boolean;
  elidedEnd: boolean;
}
