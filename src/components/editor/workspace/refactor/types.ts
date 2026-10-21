import type { LspLocation, LspWorkspaceEdit, LspWorkspaceEditOperation } from "../../../../lib/editor/lsp";
import type { CapabilityEvidenceV3 } from "../capabilityEvidence";

/**
 * §8.20.6 W5 / §8.21.2 V1: Unified refactoring plan & verification gate.
 *
 * All effectful code modifications from Rename, Safe Delete, `refactor.*`
 * Code Actions, and Generate actions pass through `refactorApplyGate`.
 */

export type RefactorKind =
  | "rename"
  | "safe-delete"
  | "extract"
  | "inline"
  | "change-signature"
  | "move"
  | "replace"
  | "other";

export interface SafeDeleteAttestationV1 {
  providerId: string;
  providerVersion: string;
  projectFingerprint: string;
  capability: "safe-delete";
  coverage: "provider-complete";
  supportedSymbolKinds: readonly string[];
  proof: { kind: "provider-command" | "code-action-data"; id: string; };
}

export type DestructiveRefactorAvailability =
  | { state: "enabled"; attestation: SafeDeleteAttestationV1; }
  | { state: "disabled"; reasonCode: "provider-no-safe-delete-attestation"; message: string; };

export type RefactorCompleteness =
  | "provider-complete"
  | "provider-partial"
  | "unknown";

export type RefactorUriOwner = "workspace" | "library" | "external";

export interface RefactorConflictV3 {
  severity: "warning" | "error";
  message: string;
  location: LspLocation | null;
}

export type RefactorConflictSource =
  | "reported"
  | "provider-asserted"
  | "protocol-bounded"
  | "client-observed-bounded"
  | "local-policy"
  | "unknown";

export interface RefactorFactV4<T> {
  value: T;
  source: "provider-asserted" | "protocol-bounded" | "client-observed-bounded" | "local-policy" | "unknown";
  proof: string | null;
}

export interface RefactorDocumentPreconditionV4 {
  uri: string;
  canonicalPath: string | null;
  expectedDocumentRevision: number | null;
  expectedDiskHash: string | null;
  owner: RefactorUriOwner;
  preTextSha256?: string | null;
  expectedPostHash?: string | null;
}

export interface RefactorPlanV4 {
  actionId: string;
  kind: RefactorKind;
  evidence: CapabilityEvidenceV3;
  completeness: RefactorFactV4<"complete" | "partial" | "unknown">;
  conflicts: readonly (RefactorConflictV3 & { source: RefactorConflictSource; })[];
  operations: readonly LspWorkspaceEditOperation[];
  documents: readonly RefactorDocumentPreconditionV4[];
  requiredOperationIndexes: readonly number[];
  excludableGroups: readonly {
    id: string;
    label: string;
    operationIndexes: readonly number[];
    required: boolean;
  }[];
  /** Backwards-compatible affected URIs */
  affectedUris: readonly {
    uri: string;
    revision: number | null;
    owner: RefactorUriOwner;
  }[];
  /**
   * ED-PROJECT-005: the ready project-facts snapshot this plan was built
   * against. Null when no same-workspace ready snapshot existed: the plan
   * carries no scope facts instead of a foreign generation. The apply gate
   * blocks plans whose generation no longer matches live facts.
   */
  projectFacts?: {
    workspaceRoot: string;
    generation: number;
    fingerprint: string | null;
  } | null;
}

export type RefactorPlanV3 = RefactorPlanV4;

/**
 * ED-IMPROVE-002: the subset of a refactor plan the shared apply boundary
 * needs to prepare a crash-recovery journal and verify post-hashes. Workflow
 * execute owners build this directly from their own frozen plan instead of
 * creating a second competing recovery/history system.
 */
export interface WorkspaceEditRecoveryPlan {
  actionId: string;
  kind: RefactorKind;
  documents: readonly RefactorDocumentPreconditionV4[];
}

export interface RefactorGateDecision {
  allowed: boolean;
  requiresConfirm: boolean;
  requiresPreview: boolean;
  reason: string | null;
  blockingConflicts: readonly RefactorConflictV3[];
  warningConflicts: readonly RefactorConflictV3[];
}

export interface BuildRefactorPlanInput {
  actionId: string;
  kind: RefactorKind;
  evidence: CapabilityEvidenceV3;
  edit: LspWorkspaceEdit;
  roots: readonly { path: string; }[];
  openFiles?: Record<string, {
    documentRevision?: number;
    revision?: number;
    diskHash?: string;
    expectedDiskHash?: string;
    canonicalPath?: string;
    text?: string;
    dirty?: boolean;
    readOnly?: boolean;
    library?: unknown;
  }>;
  currentTexts?: Record<string, string>;
  conflicts?: readonly (RefactorConflictV3 & { source?: RefactorConflictSource; })[];
  completeness?: RefactorCompleteness | RefactorFactV4<"complete" | "partial" | "unknown">;
  requiredOperationIndexes?: readonly number[];
  /**
   * ED-PROJECT-005: explicit facts snapshot for the plan. When omitted, the
   * builder records the live ready snapshot for the first root (or null).
   * Tests pass this explicitly to stay hermetic.
   */
  projectFacts?: {
    workspaceRoot: string;
    generation: number;
    fingerprint: string | null;
  } | null;
}

/**
 * ED-REF-001-A4: Recovery journal entry holding before/after preimages and
 * hashes so that restart recovery can replay or restore consistently.
 */
export interface RefactorRecoveryDocumentSnapshot {
  uri: string;
  canonicalPath: string | null;
  preText: string;
  preHash: string;
  postText: string;
  postHash: string;
}

export interface RefactorRecoveryJournalEntry {
  recoveryId: string;
  actionId: string;
  kind: RefactorKind;
  workspaceRoot: string;
  createdAt: number;
  status: "prepared" | "committed" | "rolled-back";
  documents: readonly RefactorRecoveryDocumentSnapshot[];
}

/**
 * ED-AUDIT-014 v2 recovery journal.
 *
 * Unlike v1, a v2 entry is persisted BEFORE the first mutation with a typed
 * success/failure result, carries the actually-applied edit's postimages,
 * per-resource encoding/BOM/EOL, the applied operation index, and an explicit
 * verification record. v1 entries stay readable but are never parsed as v2 or
 * auto-replayed.
 */

export interface RefactorRecoveryDocumentSnapshotV2 {
  uri: string;
  canonicalPath: string | null;
  preText: string;
  preHash: string;
  postText: string;
  postHash: string;
  encoding: string;
  bom: boolean;
  eol: "lf" | "crlf" | "cr" | null;
}

export type RefactorRecoveryStatusV2 =
  | "prepared" // persisted before the first mutation; may or may not have mutated
  | "recovery-required" // postcondition mismatch or read failure; never a success
  | "committed" // every postcondition verified; normal history/undo registered
  | "rolled-back";
// recovery confirmed every preHash via independent read-back

export interface RefactorRecoveryJournalEntryV2 {
  schemaVersion: 2;
  recoveryId: string;
  transactionId: string;
  actionId: string;
  kind: RefactorKind;
  workspaceRoot: string;
  createdAt: number;
  updatedAt: number;
  status: RefactorRecoveryStatusV2;
  /** Index of the last settled operation before the run stopped; null when the full edit applied. */
  appliedOperationIndex: number | null;
  documents: readonly RefactorRecoveryDocumentSnapshotV2[];
  /**
   * ED-FOLLOW-001: server-side file moves journalled alongside the text
   * documents. A rename's content usually also rides a text op (whose
   * snapshot carries the pre/post images); the move record pins the
   * old->new path pair so crash recovery can reverse the relocation itself.
   * Empty for text-only transactions and for entries written before moves
   * were journalled.
   */
  resourceMoves: readonly RefactorRecoveryResourceMoveV1[];
  /**
   * java-rename-deleted-recovery (RC-02, DEC-01/02): explicit user handling
   * for a pending entry. `user-dismissed` ends only the recovery reminder
   * for this record and keeps the current on-disk deletion state; it never
   * rebuilds files, edits references, or rewrites status/pre/post history.
   * Absent on historical entries, which stay pending until handled.
   */
  resolution?: {
    kind: "user-dismissed";
    resolvedAt: number;
    reason: "keep-current-state";
  };
  verification: {
    mismatchedUris: readonly string[];
    checkedAt: number | null;
    /**
     * ED-FOLLOW-001: new-paths the recovery run moved back to their old
     * paths. Read by QA to prove the reversal happened; never inferred.
     */
    reversedMoves?: readonly string[];
    /** ED-REPAIR-004: real applied effects and failed outcomes recorded in the persistent journal. */
    appliedEffects?: readonly string[];
    failedEffects?: readonly {
      path: string;
      status: string;
      reason?: string | null;
      diskEffect?: string;
    }[];
    lastRecoveryError?: string | null;
    restoredUris?: readonly string[];
  };
}

/**
 * ED-FOLLOW-001: one journalled server-side file relocation.
 * `contentHash` is the hash of the moved bytes at prepare time, taken from
 * the matching text-op preimage when the moved file also carries text edits;
 * null when the move has no text op (reversal then moves bytes without a
 * content proof and reports the move as content-unverified).
 */
export interface RefactorRecoveryResourceMoveV1 {
  oldUri: string;
  newUri: string;
  oldPath: string | null;
  newPath: string | null;
  contentHash: string | null;
}

export type RefactorJournalWriteResult =
  | { ok: true; }
  | { ok: false; reason: string; };

export interface RefactorRecoveryJournalListingV2 {
  /** Validated v2 entries, newest first. */
  entries: RefactorRecoveryJournalEntryV2[];
  /** v1 keys found; counted but never parsed as v2 or replayed. */
  legacyCount: number;
  /** Unparseable or schema-invalid records under the v2 prefix. */
  invalidCount: number;
}

export interface RefactorRecoveryPreImageV2 {
  uri: string;
  canonicalPath: string | null;
  preText: string;
  encoding?: string;
  bom?: boolean;
  eol?: "lf" | "crlf" | "cr" | null;
}

/**
 * Typed journal preparation for a plan-gated edit. `unsupported` marks the
 * explicit recovery boundary for create/delete resource operations: the
 * transaction proceeds without a journal instead of faking coverage.
 * `incomplete` means a text target has no preimage — the caller must abort
 * before any mutation because a complete journal cannot be built.
 *
 * ED-FOLLOW-001: rename (file-move) operations ARE journalled — the move
 * pair plus the moved bytes' content hash ride the entry so crash recovery
 * can reverse the relocation. Only create/delete stay unsupported.
 */
export type RefactorRecoveryJournalPreparation =
  | { state: "prepared"; entry: RefactorRecoveryJournalEntryV2; }
  | { state: "unsupported"; reason: string; }
  | { state: "incomplete"; reason: string; };

/**
 * RC-03: content proof for one journalled file move.
 *
 * The v2 `resourceMoves.contentHash` keeps its historical meaning (the moved
 * bytes at prepare time, i.e. the matching text-op preimage). For a mixed
 * text+rename transaction the live bytes at the new path are the POST image,
 * so comparing only against `contentHash` falsely conflicts a healthy
 * rename. When a unique journal document matches the move, that document's
 * recorded pre/post images are authoritative: either image (under the
 * shared encode/EOL rules) proves the bytes. A pure move without a document
 * keeps the legacy `contentHash` proof; a move with neither stays
 * content-unverified and never upgrades to verified. Multiple matching
 * documents or an indeterminate chain stage refuses to guess.
 */
export type RefactorRecoveryMoveProof =
  | { kind: "document"; doc: RefactorRecoveryDocumentSnapshotV2; }
  | { kind: "legacy-hash"; hash: string; }
  | { kind: "unverified"; }
  | { kind: "ambiguous"; reason: string; };
