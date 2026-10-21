import type { LspTextEdit, LspWorkspaceEdit } from "../../../../lib/editor/lsp";
import { type WorkspaceEditPreview } from "../workspaceEditPreview";

export interface RearrangeCapabilities {
  rearrangeSupported: boolean;
  providerId?: string;
  providerVersion?: string;
}

export interface RearrangeInput {
  scope: "selection" | "file";
  targetPath: string | null;
  languageId: string | null;
  readOnly: boolean;
  hasSelection: boolean;
  capabilities: RearrangeCapabilities;
}

export type RearrangeDecision =
  | {
    kind: "execute";
    scope: "selection" | "file";
    stage: "rearrange";
    provider?: { id: string; version?: string; };
  }
  | {
    kind: "unavailable";
    scope: "selection" | "file";
    reason: string;
  };

export interface CleanupCapabilities {
  cleanupSupported: boolean;
  providerId?: string;
  providerVersion?: string;
  supportedProfiles?: readonly string[];
}

export interface CleanupInput {
  scope: "file" | "directory" | "module" | "project";
  targetPath: string | null;
  languageId: string | null;
  readOnly: boolean;
  profileId?: string;
  capabilities: CleanupCapabilities;
}

export type CleanupDecision =
  | {
    kind: "execute";
    scope: "file" | "directory" | "module" | "project";
    stage: "cleanup";
    profileId: string;
    provider?: { id: string; version?: string; };
  }
  | {
    kind: "unavailable";
    scope: "file" | "directory" | "module" | "project";
    reason: string;
  };

export interface WorkflowPrecondition {
  uri: string;
  path: string;
  preTextSha256: string;
  documentRevision?: number;
  expectedPostHash: string;
}

export interface WorkflowConflict {
  uri: string;
  path: string;
  reason: "dirty-open-buffer" | "external-divergence" | "read-only" | "version-mismatch";
  message: string;
}

export interface WorkflowPlan {
  workflow: "rearrange" | "cleanup";
  scope: "selection" | "file" | "directory" | "module" | "project";
  profileId?: string;
  provider: { id: string; version?: string; };
  preconditions: readonly WorkflowPrecondition[];
  edit: LspWorkspaceEdit;
  preview: WorkspaceEditPreview;
  conflicts: readonly WorkflowConflict[];
  expectedPostHashes: Record<string, string>;
}

export interface BuildRearrangePlanInput {
  scope: "selection" | "file";
  targetPath: string;
  targetUri: string;
  currentText: string;
  /** Editor revision precondition; not the provider version. */
  documentRevision?: number;
  /** Provider-synchronized LSP version carried into the immutable edit. */
  documentVersion?: number | null;
  readOnly: boolean;
  provider: { id: string; version?: string; };
  edits: readonly LspTextEdit[];
  isDirty?: boolean;
}

export interface BuildCleanupPlanInput {
  scope: "file" | "directory" | "module" | "project";
  targetPath: string;
  targetUri: string;
  currentText: string;
  /** Editor revision precondition; not the provider version. */
  documentRevision?: number;
  /** Provider-synchronized LSP version carried into the immutable edit. */
  documentVersion?: number | null;
  readOnly: boolean;
  profileId?: string;
  provider: { id: string; version?: string; };
  edits: readonly LspTextEdit[];
  isDirty?: boolean;
}

export interface RearrangeProviderAction {
  kind: string | null;
  title: string;
  raw: unknown;
}

export type RearrangeRequestState = "ok" | "stale" | "failed" | "cancelled";

export interface RearrangeRequestResult {
  state: RearrangeRequestState;
  actions: readonly RearrangeProviderAction[];
  reason?: string;
}

export type RearrangeResolveState = "resolved" | "failed" | "stale" | "unsupported";

export interface RearrangeResolveResult {
  state: RearrangeResolveState;
  edits: readonly LspTextEdit[];
  /** ED-MAIN-003: provider-synchronized version validated for these edits. */
  documentVersion?: number | null;
  reason?: string;
}

export interface RearrangeLiveDocument {
  text: string;
  revision: number;
  readOnly: boolean;
  dirty: boolean;
}

export interface RearrangePreviewSummary {
  targetPath: string;
  operationCount: number;
  preHashShort: string;
  postHashShort: string;
}

export type RearrangeApplyState =
  | "applied"
  | "recovery-required"
  | "unknown-effect"
  | "failed"
  | "conflict";

export interface RearrangeApplyResult {
  state: RearrangeApplyState;
  postText?: string;
  reason?: string;
  recoveryId?: string | null;
  affectedPaths?: readonly string[];
  historyId?: string | null;
}

/**
 * Typed terminal failure states for one execute attempt (shared-contract §3).
 * A caller never has to guess from prose whether the provider was absent, the
 * user cancelled, a frozen identity went stale, or execution actually failed.
 */
export type WorkflowExecuteFailureState =
  | "unsupported"
  | "unavailable"
  | "cancelled"
  | "stale"
  | "conflict"
  | "failed"
  | "recovery-required"
  | "unknown-effect";

/**
 * ED-IMPROVE-002: the effect axis is independent of the execution status. A
 * failed operation may still have performed work (`performed`/`partial`) or
 * have an unprovable OS result (`unknown`); only `none` proves zero effect.
 */
export type WorkflowEffect =
  | { kind: "none"; }
  | { kind: "performed"; paths: readonly string[]; recoveryId: string | null; }
  | { kind: "partial"; paths: readonly string[]; recoveryId: string | null; }
  | { kind: "unknown"; paths: readonly string[]; recoveryId: string | null; };

/**
 * ED-IMPROVE-002: identity facts the execute owner hands to the canonical
 * apply boundary so it can build one recovery journal and verify the exact
 * post-hash the workflow planned.
 */
export interface WorkflowApplyContext {
  targetPath: string;
  targetUri: string;
  preText: string;
  expectedPostHash: string;
}

export type WorkflowIdentityCheck =
  | { ok: true; }
  | { ok: false; state: "cancelled" | "stale" | "conflict"; reason: string; };

/**
 * ED-IMPROVE-001: frozen-identity barrier shared by the workflow execute
 * owner and the canonical apply boundary. The workflow checks it after every
 * await window; the Tab apply adapter wires `assertCurrent` into
 * `preflightMutation`, so the last check runs immediately before the first
 * irreversible mutation, after preview dialogs have closed.
 */
export interface WorkflowMutationGuard {
  check(): WorkflowIdentityCheck;
  assertCurrent(): void;
}

export interface WorkflowIdentityDeps {
  readLive(): RearrangeLiveDocument | CleanupLiveDocument | null;
  providerGeneration(): number;
  requestToken?(): number;
}

export interface FrozenWorkflowIdentity {
  targetPath: string;
  textSha256: string;
  providerGeneration: number;
  requestToken?: number;
}

export interface RearrangeExecuteDeps {
  requestActions(): Promise<RearrangeRequestResult>;
  resolveAction(action: RearrangeProviderAction): Promise<RearrangeResolveResult>;
  readLive(): RearrangeLiveDocument | null;
  providerGeneration(): number;
  /** Monotonic UI request token; a newer value supersedes the in-flight run. */
  requestToken?(): number;
  confirmPreview(summary: RearrangePreviewSummary): Promise<boolean>;
  /**
   * Canonical apply; receives the pre-mutation identity barrier and the
   * frozen postcondition facts used for the recovery journal and history.
   */
  applyEdit(
    edit: LspWorkspaceEdit,
    guard: WorkflowMutationGuard,
    context: WorkflowApplyContext,
  ): Promise<RearrangeApplyResult>;
}

export interface RearrangeExecuteInput {
  scope: "selection" | "file";
  targetPath: string;
  targetUri: string;
  readOnly: boolean;
  hasSelection: boolean;
  capabilities: RearrangeCapabilities;
}

export type RearrangeExecuteResult =
  | { ok: true; postHash: string; operationCount: number; historyId: string | null; }
  | {
    ok: false;
    state: WorkflowExecuteFailureState;
    reason: string;
    effect: WorkflowEffect;
    committed: false;
  };

// ---------------------------------------------------------------------------
// ED-IMPROVE-003: complete provider-payload validation for the dedicated
// rearrange/cleanup actions. The workflow only ever gets an immutable,
// current-file-only text-edit plan; anything else fails typed instead of
// being silently filtered or partially executed.
// ---------------------------------------------------------------------------

export interface WorkflowProviderActionPayload {
  kind: string | null;
  title: string;
  edit: LspWorkspaceEdit | null;
  command: string | null;
  commandArguments: unknown;
  raw: unknown;
}

export interface WorkflowActionValidationInput {
  action: WorkflowProviderActionPayload | null;
  targetUri: string;
  targetPath: string;
  documentText: string;
  /**
   * ED-MAIN-003: editor revision (ui/documentRevision) is kept separate from the
   * provider-synchronized LSP version. Only the latter may be compared with a
   * TextDocumentEdit `version`.
   */
  documentRevision?: number;
  /** Actual LSP document version currently synchronized with the provider. */
  documentVersion?: number | null;
  isSupportedKind(kind: string | null): boolean;
  capabilityLabel: string;
}

export type WorkflowActionValidation =
  | {
    ok: true;
    edits: readonly LspTextEdit[];
    /**
     * The provider document version proven for this payload (the action's
     * version when present), or null for an unversioned payload that relies on
     * the hash/generation/liveness gates.
     */
    documentVersion: number | null;
  }
  | {
    ok: false;
    state: "unsupported" | "stale" | "failed";
    reason: string;
  };

/**
 * ED-MAIN-002: a provider action is disabled either by the legacy boolean
 * `disabled: true` or by the LSP-standard `disabled: { reason }` object.
 * Missing/null/false values are not disabled; an empty object still is.
 */
export interface WorkflowActionDisabledFact {
  disabled: boolean;
  reason: string | null;
}

export interface WorkflowActionSelection<T extends { kind: string | null; raw: unknown; title: string; }> {
  action: T | null;
  disabled: { action: T; reason: string | null; } | null;
}

export interface CleanupProviderAction {
  kind: string | null;
  title: string;
  raw: unknown;
}

export type CleanupRequestState = "ok" | "stale" | "failed" | "cancelled";

export interface CleanupRequestResult {
  state: CleanupRequestState;
  actions: readonly CleanupProviderAction[];
  reason?: string;
}

export type CleanupResolveState = "resolved" | "failed" | "stale" | "unsupported";

export interface CleanupResolveResult {
  state: CleanupResolveState;
  edits: readonly LspTextEdit[];
  /** ED-MAIN-003: provider-synchronized version validated for these edits. */
  documentVersion?: number | null;
  reason?: string;
}

export interface CleanupLiveDocument {
  text: string;
  revision: number;
  readOnly: boolean;
  dirty: boolean;
}

export interface CleanupPreviewSummary {
  targetPath: string;
  profileId: string;
  operationCount: number;
  preHashShort: string;
  postHashShort: string;
}

export type CleanupApplyState =
  | "applied"
  | "recovery-required"
  | "unknown-effect"
  | "failed"
  | "conflict";

export interface CleanupApplyResult {
  state: CleanupApplyState;
  postText?: string;
  reason?: string;
  recoveryId?: string | null;
  affectedPaths?: readonly string[];
  historyId?: string | null;
}

export interface CleanupExecuteDeps {
  requestActions(): Promise<CleanupRequestResult>;
  resolveAction(action: CleanupProviderAction): Promise<CleanupResolveResult>;
  readLive(): CleanupLiveDocument | null;
  providerGeneration(): number;
  /** Monotonic UI request token; a newer value supersedes the in-flight run. */
  requestToken?(): number;
  confirmPreview(summary: CleanupPreviewSummary): Promise<boolean>;
  /**
   * Canonical apply; receives the pre-mutation identity barrier and the
   * frozen postcondition facts used for the recovery journal and history.
   */
  applyEdit(
    edit: LspWorkspaceEdit,
    guard: WorkflowMutationGuard,
    context: WorkflowApplyContext,
  ): Promise<CleanupApplyResult>;
}

export interface CleanupExecuteInput {
  scope: "file" | "directory" | "module" | "project";
  targetPath: string;
  targetUri: string;
  readOnly: boolean;
  profileId?: string;
  capabilities: CleanupCapabilities;
}

export type CleanupExecuteResult =
  | { ok: true; postHash: string; operationCount: number; historyId: string | null; }
  | {
    ok: false;
    state: WorkflowExecuteFailureState;
    reason: string;
    effect: WorkflowEffect;
    committed: false;
  };
