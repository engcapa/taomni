import { type LspWorkspaceEdit } from "../../../../lib/editor/lsp";
import { type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import type { OpenFileEol } from "../editorGroupTypes";
import { type WorkspaceEditApplyTransactionSummary } from "../workspaceEditApply";
import { type RefactorKind, type RefactorPlanV3, type WorkspaceEditRecoveryPlan } from "../refactorPlan";
import { type ReplaceFilePreimage } from "../replaceInFilesModel";


export interface TreeOpenIntent {
    workspaceInstanceId: string;
    groupId: EditorGroupId;
    requestedFileKey: string;
    canonicalFileKey?: string;
    interactionEpoch: number;
    requestId: number;
  }

export type MutationReason =
    | "user-edit"
    | "programmatic"
    | "reload"
    | "workspace-edit"
    | "save-writeback"
    | "save-metadata"
    | "history-replay";

export interface BufferMutationPatch {
    text?: string;
    savedText?: string;
    eol?: OpenFileEol;
    encoding?: string;
    bom?: boolean;
    hash?: string;
    mtime?: number;
    size?: number;
    loading?: boolean;
    saving?: boolean;
    dirty?: boolean;
    error?: string | null;
    documentRevision?: number;
  }

export type WorkspaceEditApplyOptions = {
    preview?: boolean;
    label?: string | null;
    actionId?: string | null;
    kind?: RefactorKind;
    semanticGeneration?: number;
    semanticRevision?: number;
    /** Provider command continuations are exact-revision guarded after their first edit. */
    semanticRequireReady?: boolean;
    /** Internal history replay must not create another history entry. */
    recordHistory?: boolean;
    /** Restrict provider edits to the opened workspace roots. */
    semanticWorkspaceOnly?: boolean;
    /** Optional refactoring plan with completeness, conflicts, and required groups. */
    plan?: RefactorPlanV3 | WorkspaceEditRecoveryPlan;
    /** Canonical transaction guard, invoked after preview and immediately before mutation. */
    preflightMutation?: () => Promise<void> | void;
    /**
     * ED-PARITY-007: extra synchronous guard evaluated at the exact mutation
     * boundary, after every read and immediately before the first write. Used
     * by the Extract naming step to re-verify its owner after async snapshot
     * reads and the shared preview.
     */
    assertOwnerAtMutationBoundary?: () => void;
    /**
     * ED-IMPROVE-002: structured transaction facts (effect, postcondition,
     * history/recovery identity) reported by the shell's apply owner.
     */
    onTransactionSummary?: (summary: WorkspaceEditApplyTransactionSummary) => void;
    /** Reports the exact edit selected by the preview dialog. */
    onActiveEditResolved?: (edit: LspWorkspaceEdit) => void;
    /**
     * ED-MAIN-005: frozen per-file disk hashes (normalized path key -> text
     * hash) captured when the replace preview opened. The closed-file read
     * refuses when live disk no longer matches, so an old range can never be
     * re-anchored onto text read again later.
     */
    expectedDiskHashes?: ReadonlyMap<string, string> | null;
    /**
     * ED-REPAIR-002: frozen per-file preimages captured when the replace
     * preview opened. Enforces open buffer revision/dirty integrity and
     * closed-file disk hash integrity before and during mutation.
     */
    expectedPreimages?: readonly ReplaceFilePreimage[] | null;
  };
