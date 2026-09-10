/**
 * ED-STYLE-002 / C8-D: Rearrange Code & Code Cleanup independent workflows.
 *
 * Dedicated planner, execution gates, preview, and verification for
 * Rearrange Code and Code Cleanup workflows.
 * These actions FAIL CLOSED with honest, typed explanations when the language
 * server/provider does not advertise dedicated rearrange/cleanup capabilities.
 * They never disguise format or organize imports as rearrange/cleanup.
 */

import type {
  LspCapabilitySummary,
  LspDocumentStatus,
  LspTextEdit,
  LspWorkspaceEdit,
} from "../../../lib/editor/lsp";
import { applyLspTextEditsToString } from "./lspTextEdits";
import { fsPathEquals } from "./codeWorkspaceModel";
import { sha256Hex } from "./projectAnalysisModel";
import {
  buildWorkspaceEditPreview,
  type WorkspaceEditPreview,
} from "./workspaceEditPreview";

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
      provider?: { id: string; version?: string };
    }
  | {
      kind: "unavailable";
      scope: "selection" | "file";
      reason: string;
    };

export function resolveRearrangeCapabilities(
  capabilities?: LspCapabilitySummary | null,
  status?: LspDocumentStatus | null,
): RearrangeCapabilities {
  if (!capabilities) {
    return {
      rearrangeSupported: false,
      providerId: status?.displayName ?? status?.presetId ?? undefined,
    };
  }

  const codeActionKinds = capabilities.codeActionKinds ?? [];
  const hasRearrangeCodeAction =
    codeActionKinds.includes("source.rearrange") ||
    codeActionKinds.includes("source.rearrangeCode") ||
    codeActionKinds.includes("rearrange");
  const isExplicitlySupported =
    (capabilities as unknown as { rearrangeSupported?: boolean }).rearrangeSupported === true;

  const providerId =
    (capabilities as unknown as { rearrangeProvider?: { id: string; version?: string } })
      ?.rearrangeProvider?.id ??
    status?.displayName ??
    status?.presetId ??
    "lsp";
  const providerVersion =
    (capabilities as unknown as { rearrangeProvider?: { id: string; version?: string } })
      ?.rearrangeProvider?.version;

  return {
    rearrangeSupported: Boolean(hasRearrangeCodeAction || isExplicitlySupported),
    providerId,
    providerVersion,
  };
}

export function planRearrange(input: RearrangeInput): RearrangeDecision {
  const requestedScope: "selection" | "file" =
    input.scope === "selection" && input.hasSelection ? "selection" : "file";

  if (!input.targetPath) {
    return {
      kind: "unavailable",
      scope: requestedScope,
      reason: "No file is open to rearrange",
    };
  }

  if (input.readOnly) {
    return {
      kind: "unavailable",
      scope: requestedScope,
      reason: `${input.targetPath} is read-only and cannot be rearranged`,
    };
  }

  if (!input.capabilities.rearrangeSupported) {
    const providerLabel = input.capabilities.providerId;
    return {
      kind: "unavailable",
      scope: requestedScope,
      reason: providerLabel
        ? `${providerLabel} does not support member-rearrangement for ${input.languageId ?? "this file type"}. Rearrange Code requires a dedicated arrangement provider.`
        : `No member-rearrangement provider is available for ${input.languageId ?? "this file type"}. Rearrange Code requires a dedicated arrangement provider.`,
    };
  }

  const decision: RearrangeDecision = {
    kind: "execute",
    scope: requestedScope,
    stage: "rearrange",
  };
  if (input.capabilities.providerId) {
    decision.provider = {
      id: input.capabilities.providerId,
      version: input.capabilities.providerVersion,
    };
  }
  return decision;
}

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
      provider?: { id: string; version?: string };
    }
  | {
      kind: "unavailable";
      scope: "file" | "directory" | "module" | "project";
      reason: string;
    };

export function resolveCleanupCapabilities(
  capabilities?: LspCapabilitySummary | null,
  status?: LspDocumentStatus | null,
): CleanupCapabilities {
  if (!capabilities) {
    return {
      cleanupSupported: false,
      providerId: status?.displayName ?? status?.presetId ?? undefined,
    };
  }

  const codeActionKinds = capabilities.codeActionKinds ?? [];
  const hasCleanupCodeAction =
    codeActionKinds.includes("source.cleanup") ||
    codeActionKinds.includes("source.fixAll") ||
    codeActionKinds.includes("cleanup");
  const isExplicitlySupported =
    (capabilities as unknown as { cleanupSupported?: boolean }).cleanupSupported === true;

  const providerId =
    (capabilities as unknown as { cleanupProvider?: { id: string; version?: string } })
      ?.cleanupProvider?.id ??
    status?.displayName ??
    status?.presetId ??
    "lsp";
  const providerVersion =
    (capabilities as unknown as { cleanupProvider?: { id: string; version?: string } })
      ?.cleanupProvider?.version;

  const supportedProfiles =
    (capabilities as unknown as { supportedProfiles?: readonly string[] }).supportedProfiles ??
    (capabilities as unknown as { cleanupProvider?: { supportedProfiles?: readonly string[] } })
      ?.cleanupProvider?.supportedProfiles ??
    ["default", "full-cleanup"];

  return {
    cleanupSupported: Boolean(hasCleanupCodeAction || isExplicitlySupported),
    providerId,
    providerVersion,
    supportedProfiles,
  };
}

export function planCleanup(input: CleanupInput): CleanupDecision {
  if (!input.targetPath) {
    return {
      kind: "unavailable",
      scope: input.scope,
      reason: "No target is selected for code cleanup",
    };
  }

  if (input.readOnly) {
    return {
      kind: "unavailable",
      scope: input.scope,
      reason: `${input.targetPath} is read-only and cannot be cleaned up`,
    };
  }

  if (!input.capabilities.cleanupSupported) {
    const providerLabel = input.capabilities.providerId;
    return {
      kind: "unavailable",
      scope: input.scope,
      reason: providerLabel
        ? `${providerLabel} does not support code cleanup for ${input.languageId ?? "this scope"}. Code Cleanup requires a dedicated batch cleanup provider.`
        : `No code cleanup provider is available for ${input.languageId ?? "this scope"}. Code Cleanup requires a dedicated batch cleanup provider.`,
    };
  }

  const decision: CleanupDecision = {
    kind: "execute",
    scope: input.scope,
    stage: "cleanup",
    profileId: input.profileId ?? "default",
  };
  if (input.capabilities.providerId) {
    decision.provider = {
      id: input.capabilities.providerId,
      version: input.capabilities.providerVersion,
    };
  }
  return decision;
}

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
  provider: { id: string; version?: string };
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
  documentRevision?: number;
  readOnly: boolean;
  provider: { id: string; version?: string };
  edits: readonly LspTextEdit[];
  isDirty?: boolean;
}

export function buildRearrangePlan(input: BuildRearrangePlanInput): WorkflowPlan {
  const conflicts: WorkflowConflict[] = [];
  if (input.readOnly) {
    conflicts.push({
      uri: input.targetUri,
      path: input.targetPath,
      reason: "read-only",
      message: `${input.targetPath} is read-only and cannot be rearranged`,
    });
  }
  if (input.isDirty) {
    conflicts.push({
      uri: input.targetUri,
      path: input.targetPath,
      reason: "dirty-open-buffer",
      message: `${input.targetPath} has uncommitted open changes`,
    });
  }

  const preTextSha256 = sha256Hex(input.currentText);
  const postText = applyLspTextEditsToString(input.currentText, input.edits);
  const expectedPostHash = sha256Hex(postText);

  const edit: LspWorkspaceEdit = {
    documentEdits: [
      {
        uri: input.targetUri,
        path: input.targetPath,
        version: input.documentRevision,
        edits: [...input.edits],
      },
    ],
  };

  const preview = buildWorkspaceEditPreview(edit, { label: "Rearrange Code" });

  const precondition: WorkflowPrecondition = {
    uri: input.targetUri,
    path: input.targetPath,
    preTextSha256,
    documentRevision: input.documentRevision,
    expectedPostHash,
  };

  return {
    workflow: "rearrange",
    scope: input.scope,
    provider: input.provider,
    preconditions: [precondition],
    edit,
    preview,
    conflicts,
    expectedPostHashes: { [input.targetPath]: expectedPostHash },
  };
}

export interface BuildCleanupPlanInput {
  scope: "file" | "directory" | "module" | "project";
  targetPath: string;
  targetUri: string;
  currentText: string;
  documentRevision?: number;
  readOnly: boolean;
  profileId?: string;
  provider: { id: string; version?: string };
  edits: readonly LspTextEdit[];
  isDirty?: boolean;
}

export function buildCleanupPlan(input: BuildCleanupPlanInput): WorkflowPlan {
  const conflicts: WorkflowConflict[] = [];
  if (input.readOnly) {
    conflicts.push({
      uri: input.targetUri,
      path: input.targetPath,
      reason: "read-only",
      message: `${input.targetPath} is read-only and cannot be cleaned up`,
    });
  }
  if (input.isDirty) {
    conflicts.push({
      uri: input.targetUri,
      path: input.targetPath,
      reason: "dirty-open-buffer",
      message: `${input.targetPath} has uncommitted open changes`,
    });
  }

  const preTextSha256 = sha256Hex(input.currentText);
  const postText = applyLspTextEditsToString(input.currentText, input.edits);
  const expectedPostHash = sha256Hex(postText);

  const edit: LspWorkspaceEdit = {
    documentEdits: [
      {
        uri: input.targetUri,
        path: input.targetPath,
        version: input.documentRevision,
        edits: [...input.edits],
      },
    ],
  };

  const preview = buildWorkspaceEditPreview(edit, { label: "Code Cleanup" });

  const precondition: WorkflowPrecondition = {
    uri: input.targetUri,
    path: input.targetPath,
    preTextSha256,
    documentRevision: input.documentRevision,
    expectedPostHash,
  };

  return {
    workflow: "cleanup",
    scope: input.scope,
    profileId: input.profileId ?? "default",
    provider: input.provider,
    preconditions: [precondition],
    edit,
    preview,
    conflicts,
    expectedPostHashes: { [input.targetPath]: expectedPostHash },
  };
}

export function verifyWorkflowPreconditions(
  plan: WorkflowPlan,
  liveDocuments: Record<string, { text: string; revision?: number; readOnly?: boolean }>,
): { ok: boolean; conflict?: WorkflowConflict } {
  for (const pc of plan.preconditions) {
    const live = liveDocuments[pc.path] ?? liveDocuments[pc.uri];
    if (!live) continue;
    if (live.readOnly) {
      return {
        ok: false,
        conflict: {
          uri: pc.uri,
          path: pc.path,
          reason: "read-only",
          message: `${pc.path} is read-only`,
        },
      };
    }
    const currentSha = sha256Hex(live.text);
    if (currentSha !== pc.preTextSha256) {
      return {
        ok: false,
        conflict: {
          uri: pc.uri,
          path: pc.path,
          reason: "external-divergence",
          message: `${pc.path} has changed since plan generation`,
        },
      };
    }
    if (
      pc.documentRevision !== undefined &&
      live.revision !== undefined &&
      live.revision !== pc.documentRevision
    ) {
      return {
        ok: false,
        conflict: {
          uri: pc.uri,
          path: pc.path,
          reason: "version-mismatch",
          message: `${pc.path} revision ${live.revision} differs from planned ${pc.documentRevision}`,
        },
      };
    }
  }
  return { ok: true };
}

export function verifyWorkflowFreshness(
  frozenIdentity: { providerGeneration?: number; sessionId?: string },
  currentIdentity: { providerGeneration?: number; sessionId?: string },
): { ok: boolean; staleReason?: string } {
  if (
    frozenIdentity.providerGeneration !== undefined &&
    currentIdentity.providerGeneration !== undefined &&
    frozenIdentity.providerGeneration !== currentIdentity.providerGeneration
  ) {
    return {
      ok: false,
      staleReason: `Provider generation changed (${frozenIdentity.providerGeneration} -> ${currentIdentity.providerGeneration})`,
    };
  }
  if (
    frozenIdentity.sessionId !== undefined &&
    currentIdentity.sessionId !== undefined &&
    frozenIdentity.sessionId !== currentIdentity.sessionId
  ) {
    return {
      ok: false,
      staleReason: `Session identity changed (${frozenIdentity.sessionId} -> ${currentIdentity.sessionId})`,
    };
  }
  return { ok: true };
}

export function verifyWorkflowPostHashes(
  expectedPostHashes: Record<string, string>,
  appliedFiles: Record<string, string>,
): { ok: boolean; mismatchedFiles: string[] } {
  const mismatchedFiles: string[] = [];
  for (const [path, expectedHash] of Object.entries(expectedPostHashes)) {
    const actualText = appliedFiles[path];
    if (actualText === undefined) {
      mismatchedFiles.push(path);
      continue;
    }
    const actualHash = sha256Hex(actualText);
    if (actualHash !== expectedHash) {
      mismatchedFiles.push(path);
    }
  }
  return {
    ok: mismatchedFiles.length === 0,
    mismatchedFiles,
  };
}

export function cancelWorkflowPlan(_plan?: WorkflowPlan): {
  disposition: "cancelled";
  applied: boolean;
  effects: [];
} {
  return {
    disposition: "cancelled",
    applied: false,
    effects: [],
  };
}

// ---------------------------------------------------------------------------
// ED-AUDIT-015: production execute wiring for Rearrange Code.
// ---------------------------------------------------------------------------

/**
 * Provider action kinds that count as a dedicated arrangement capability.
 * Matched by exact kind equality only — never by summary booleans or title
 * substring guessing. `source.sortMembers` is the Eclipse JDT LS
 * member-arrangement action (Sort Members support, JDT LS 1.61 #2169;
 * JavaCodeActionKind in the pinned 1.61.0 bundle; live-verified against the
 * pinned server with a bare-LSP probe returning a real edit). JDT LS never
 * advertises it in codeActionKinds, so discovery is live-only by design.
 */
export const REARRANGE_ACTION_KINDS: readonly string[] = [
  "source.rearrange",
  "source.rearrangeCode",
  "rearrange",
  "source.sortMembers",
];

export function isRearrangeActionKind(kind: string | null): boolean {
  return kind !== null && REARRANGE_ACTION_KINDS.includes(kind);
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
  | { kind: "none" }
  | { kind: "performed"; paths: readonly string[]; recoveryId: string | null }
  | { kind: "partial"; paths: readonly string[]; recoveryId: string | null }
  | { kind: "unknown"; paths: readonly string[]; recoveryId: string | null };

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
  | { ok: true }
  | { ok: false; state: "cancelled" | "stale" | "conflict"; reason: string };

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

interface WorkflowIdentityDeps {
  readLive(): RearrangeLiveDocument | CleanupLiveDocument | null;
  providerGeneration(): number;
  requestToken?(): number;
}

interface FrozenWorkflowIdentity {
  targetPath: string;
  textSha256: string;
  providerGeneration: number;
  requestToken?: number;
}

function buildWorkflowMutationGuard(
  deps: WorkflowIdentityDeps,
  frozen: FrozenWorkflowIdentity,
): WorkflowMutationGuard {
  const check = (): WorkflowIdentityCheck => {
    const live = deps.readLive();
    if (!live) {
      return {
        ok: false,
        state: "cancelled",
        reason: `${frozen.targetPath} closed or the workspace changed`,
      };
    }
    if (live.readOnly) {
      return {
        ok: false,
        state: "conflict",
        reason: `${frozen.targetPath} became read-only`,
      };
    }
    if (sha256Hex(live.text) !== frozen.textSha256) {
      return {
        ok: false,
        state: "stale",
        reason: `${frozen.targetPath} changed since the frozen preimage`,
      };
    }
    if (
      frozen.requestToken !== undefined
      && deps.requestToken
      && deps.requestToken() !== frozen.requestToken
    ) {
      return {
        ok: false,
        state: "stale",
        reason: "a newer request superseded this one",
      };
    }
    if (deps.providerGeneration() !== frozen.providerGeneration) {
      return {
        ok: false,
        state: "stale",
        reason: `provider generation changed (${frozen.providerGeneration} -> ${deps.providerGeneration()})`,
      };
    }
    return { ok: true };
  };
  return {
    check,
    assertCurrent() {
      const current = check();
      if (!current.ok) throw new Error(current.reason);
    },
  };
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
  | { ok: true; postHash: string; operationCount: number; historyId: string | null }
  | {
    ok: false;
    state: WorkflowExecuteFailureState;
    reason: string;
    effect: WorkflowEffect;
    committed: false;
  };

/**
 * ED-AUDIT-015 + ED-IMPROVE-001 execute owner: gate -> freeze text/provider-
 * generation/request-token -> request a dedicated rearrange action -> resolve
 * to edits -> re-read live and plan from the frozen preimage -> precondition/
 * freshness gates -> confirm gate -> post-confirm identity gate -> canonical
 * apply with a final pre-mutation guard -> postcondition verify. Every early
 * return commits nothing; only a post-hash-verified apply returns ok:true.
 *
 * Revision pinning is deliberately text-anchored, not revision-anchored: a
 * background LSP sync may bump the document revision without changing a
 * byte (observed: 0 -> 1 on open), so refusing that would be a false stale.
 * A same-text revision bump re-anchors silently; any byte change refuses at
 * the next guard. The plan carries no pinned revision, so the applier's
 * version gate stays bypassed by design — the frozen text hash is re-verified
 * by the workflow after every await window and by the shared apply boundary
 * immediately before the first mutation.
 *
 * Supported-branch callers MUST mark test-double coverage as model-boundary:
 * only a live capable provider proves the provider half of this chain.
 */
export async function executeRearrangeTransaction(
  deps: RearrangeExecuteDeps,
  input: RearrangeExecuteInput,
): Promise<RearrangeExecuteResult> {
  const fail = (
    state: WorkflowExecuteFailureState,
    reason: string,
    effect: WorkflowEffect = { kind: "none" },
  ): RearrangeExecuteResult => ({ ok: false, state, reason, effect, committed: false });

  // 0. Zero-IO pre-gate: no target or readonly short-circuits without
  // touching the provider. Advertised capability support is deliberately
  // NOT decided here: Eclipse JDT LS never advertises arrangement kinds in
  // codeActionKinds (contract-pinned), so the summary boolean cannot
  // arbitrate — the spec requires resolving to a callable action, never
  // summary booleans or title guessing. Live discovery at step 3 is the
  // sole support arbiter; its absence fails typed with received kinds.
  // Messages mirror planRearrange so display paths stay consistent.
  const requestedScope: "selection" | "file" =
    input.scope === "selection" && input.hasSelection ? "selection" : "file";
  if (!input.targetPath) {
    return fail("unavailable", "No file is open to rearrange");
  }
  if (input.readOnly) {
    return fail("conflict", `${input.targetPath} is read-only and cannot be rearranged`);
  }
  const decision = {
    scope: requestedScope,
    provider: input.capabilities.providerId
      ? { id: input.capabilities.providerId, version: input.capabilities.providerVersion }
      : undefined,
  };

  // 1. Freeze every identity the operation depends on before the first
  // await: text hash (ground truth), provider generation and UI request
  // token. File/workspace identity is carried by readLive() (null once the
  // file closes or the workspace switches).
  const frozen = deps.readLive();
  if (!frozen) {
    return fail("cancelled", `${input.targetPath} is no longer open; rearrange cancelled with zero effect`);
  }
  if (frozen.readOnly) {
    return fail("conflict", `${input.targetPath} is read-only and cannot be rearranged`);
  }
  const frozenGeneration = deps.providerGeneration();
  const frozenToken = deps.requestToken?.();
  const frozenTextSha256 = sha256Hex(frozen.text);
  const guard = buildWorkflowMutationGuard(deps, {
    targetPath: input.targetPath,
    textSha256: frozenTextSha256,
    providerGeneration: frozenGeneration,
    requestToken: frozenToken,
  });
  const guardFailure = (window: string): RearrangeExecuteResult | null => {
    const current = guard.check();
    if (current.ok) return null;
    return fail(current.state, `${window} rejected the stale plan: ${current.reason}; nothing applied`);
  };

  // 2. Request dedicated provider actions (the request itself freezes identity).
  const requested = await deps.requestActions();
  if (requested.state !== "ok") {
    return fail(
      mapRequestFailureState(requested.state),
      requested.reason ?? `Rearrange request ${requested.state}; nothing applied`,
    );
  }
  const afterRequest = guardFailure("Rearrange after the provider request");
  if (afterRequest) return afterRequest;

  // 3. Resolve to a callable rearrange-kind action by exact kind equality.
  const action = requested.actions.find((candidate) => isRearrangeActionKind(candidate.kind)) ?? null;
  if (!action) {
    const seen = requested.actions
      .map((candidate) => candidate.kind ?? "(no kind)")
      .slice(0, 3)
      .join(", ");
    return fail(
      "unsupported",
      seen
        ? `Provider returned no rearrange action (received kinds: ${seen}). Rearrange Code requires a dedicated arrangement provider; nothing applied.`
        : "Provider returned no actions. Rearrange Code requires a dedicated arrangement provider; nothing applied.",
    );
  }

  // 4. Resolve the action to concrete edits, then reject if the provider or
  // document identity moved while the resolve was in flight.
  const resolved = await deps.resolveAction(action);
  if (resolved.state !== "resolved") {
    return fail(
      mapResolveFailureState(resolved.state),
      resolved.reason ?? `Rearrange resolve ${resolved.state}; nothing applied`,
    );
  }
  if (resolved.edits.length === 0) {
    return fail("unsupported", `Provider action '${action.title}' carried no edits; nothing applied`);
  }
  const afterResolve = guardFailure("Rearrange after the provider resolve");
  if (afterResolve) return afterResolve;

  // 5. Build the plan from the verified frozen preimage. A changed buffer is
  // never re-anchored onto stale edits.
  const planLive = deps.readLive();
  if (!planLive) {
    return fail("cancelled", `${input.targetPath} is no longer open; rearrange cancelled with zero effect`);
  }
  if (planLive.readOnly) {
    return fail("conflict", `${input.targetPath} is read-only and cannot be rearranged`);
  }
  if (sha256Hex(planLive.text) !== frozenTextSha256) {
    return fail("stale", `${input.targetPath} changed since the frozen preimage; request the rearrange again`);
  }
  const plan = buildRearrangePlan({
    scope: decision.scope,
    targetPath: input.targetPath,
    targetUri: input.targetUri,
    currentText: planLive.text,
    documentRevision: undefined,
    readOnly: planLive.readOnly,
    provider: decision.provider ?? { id: "provider" },
    edits: resolved.edits,
    isDirty: planLive.dirty,
  });
  if (plan.conflicts.length > 0) {
    return fail("conflict", plan.conflicts[0].message);
  }
  const preconditions = verifyWorkflowPreconditions(plan, {
    [input.targetPath]: { text: planLive.text, readOnly: planLive.readOnly },
    [input.targetUri]: { text: planLive.text, readOnly: planLive.readOnly },
  });
  if (!preconditions.ok) {
    return fail(
      preconditions.conflict?.reason === "read-only" ? "conflict" : "stale",
      preconditions.conflict?.message ?? `${input.targetPath} changed since plan generation; nothing applied`,
    );
  }
  const freshness = verifyWorkflowFreshness(
    { providerGeneration: frozenGeneration },
    { providerGeneration: deps.providerGeneration() },
  );
  if (!freshness.ok) {
    return fail("stale", `Rearrange became stale: ${freshness.staleReason}; request it again`);
  }

  // 6. Preview confirm gate: cancel commits nothing. A document that moved
  // while the preview was open invalidates the whole plan instead of being
  // re-anchored.
  const preHash = plan.preconditions[0]?.preTextSha256 ?? frozenTextSha256;
  const postHash = plan.expectedPostHashes[input.targetPath] ?? "";
  const confirmed = await deps.confirmPreview({
    targetPath: input.targetPath,
    operationCount: resolved.edits.length,
    preHashShort: preHash.slice(0, 12),
    postHashShort: postHash.slice(0, 12),
  });
  if (!confirmed) {
    cancelWorkflowPlan(plan);
    return fail("cancelled", "Rearrange cancelled before applying; nothing changed");
  }
  const afterPreview = guardFailure("Rearrange after the preview confirmation");
  if (afterPreview) {
    cancelWorkflowPlan(plan);
    return afterPreview;
  }

  // 7. Canonical apply with the last identity check inside the shared apply
  // boundary, then postcondition verification against real bytes. The apply
  // owner prepares the recovery journal before the first mutation, registers
  // exactly one success history entry only after the independent
  // postcondition matches, and reports the effect axis separately.
  const applied = await deps.applyEdit(plan.edit, guard, {
    targetPath: input.targetPath,
    targetUri: input.targetUri,
    preText: planLive.text,
    expectedPostHash: postHash,
  });
  if (applied.state !== "applied" || applied.postText === undefined) {
    // ED-IMPROVE-002: an explicit effect fact from the apply boundary wins
    // over the pre-mutation identity guard. A failed save can have mutated the
    // open buffer or the disk already; re-labelling that as "stale" would hide
    // a real/unknown effect.
    if (applied.state === "unknown-effect") {
      return fail(
        "unknown-effect",
        applied.reason ?? "Rearrange write result is unknown; verify the file before retrying",
        {
          kind: "unknown",
          paths: applied.affectedPaths ?? [input.targetPath],
          recoveryId: applied.recoveryId ?? null,
        },
      );
    }
    if (applied.state === "recovery-required") {
      return fail(
        "recovery-required",
        applied.reason
          ?? "Rearrange applied but its postcondition could not be verified; recover from the pending journal",
        {
          kind: "performed",
          paths: applied.affectedPaths ?? [input.targetPath],
          recoveryId: applied.recoveryId ?? null,
        },
      );
    }
    const current = guard.check();
    if (!current.ok) {
      return fail(
        current.state,
        applied.reason
          ? `${current.reason}: ${applied.reason}`
          : `${current.reason}; nothing applied`,
      );
    }
    const performed = applied.affectedPaths && applied.affectedPaths.length > 0;
    return fail(
      applied.state === "conflict" ? "conflict" : "failed",
      applied.reason ?? "Rearrange apply failed; see the workspace-edit ledger",
      performed
        ? {
          kind: "partial",
          paths: applied.affectedPaths ?? [],
          recoveryId: applied.recoveryId ?? null,
        }
        : { kind: "none" },
    );
  }
  const post = verifyWorkflowPostHashes(plan.expectedPostHashes, {
    [input.targetPath]: applied.postText,
  });
  if (!post.ok) {
    // The canonical apply verifies the same frozen hash before registering
    // history, so this is only reachable for a late change after that check.
    return fail(
      "failed",
      `Rearrange postcondition failed on ${post.mismatchedFiles.join(", ")}; the workspace-edit history/recovery entry owns the applied effects.`,
      { kind: "performed", paths: [input.targetPath], recoveryId: applied.recoveryId ?? null },
    );
  }
  return {
    ok: true,
    postHash: plan.expectedPostHashes[input.targetPath],
    operationCount: resolved.edits.length,
    historyId: applied.historyId ?? null,
  };
}

function mapRequestFailureState(
  state: RearrangeRequestState | CleanupRequestState,
): WorkflowExecuteFailureState {
  if (state === "cancelled") return "cancelled";
  if (state === "stale") return "stale";
  return "failed";
}

function mapResolveFailureState(
  state: RearrangeResolveState | CleanupResolveState,
): WorkflowExecuteFailureState {
  if (state === "unsupported") return "unsupported";
  if (state === "stale") return "stale";
  return "failed";
}

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
  documentRevision?: number;
  isSupportedKind(kind: string | null): boolean;
  capabilityLabel: string;
}

export type WorkflowActionValidation =
  | { ok: true; edits: readonly LspTextEdit[] }
  | {
      ok: false;
      state: "unsupported" | "stale" | "failed";
      reason: string;
    };

function workflowActionIsDisabled(raw: unknown): boolean {
  return typeof raw === "object"
    && raw !== null
    && (raw as { disabled?: unknown }).disabled === true;
}

function workflowEditRangeIsValid(edit: LspTextEdit): boolean {
  const { start, end } = edit.range;
  const positionIsWellFormed = (line: number, character: number): boolean => (
    Number.isInteger(line)
    && Number.isInteger(character)
    && line >= 0
    && character >= 0
  );
  if (!positionIsWellFormed(start.line, start.character)
    || !positionIsWellFormed(end.line, end.character)) {
    return false;
  }
  if (start.line > end.line) return false;
  return start.line < end.line || start.character <= end.character;
}

export function validateWorkflowProviderAction(
  input: WorkflowActionValidationInput,
): WorkflowActionValidation {
  const { action, targetUri, targetPath, capabilityLabel } = input;
  if (!action) {
    return {
      ok: false,
      state: "failed",
      reason: `${capabilityLabel} resolve returned no action; nothing applied`,
    };
  }
  if (workflowActionIsDisabled(action.raw)) {
    return {
      ok: false,
      state: "unsupported",
      reason: `${capabilityLabel} action '${action.title}' is disabled by the provider; nothing applied`,
    };
  }
  if (!input.isSupportedKind(action.kind)) {
    return {
      ok: false,
      state: "unsupported",
      reason: `${capabilityLabel} resolve returned kind '${action.kind ?? "(no kind)"}' instead of a dedicated action kind; nothing applied`,
    };
  }
  if (!action.edit) {
    return {
      ok: false,
      state: "unsupported",
      reason: action.command
        ? `${capabilityLabel} action '${action.title}' is command-only (${action.command}); command side effects are not supported; nothing applied`
        : `${capabilityLabel} action '${action.title}' carried no edit; nothing applied`,
    };
  }
  if (action.command) {
    return {
      ok: false,
      state: "unsupported",
      reason: `${capabilityLabel} action '${action.title}' carries both an edit and the command '${action.command}'; mixed payloads are not supported; nothing applied`,
    };
  }
  const operations = action.edit.operations ?? [];
  const resourceOperations = operations.filter((operation) => operation.kind !== "text");
  if (resourceOperations.length > 0) {
    const kinds = resourceOperations
      .map((operation) => operation.kind)
      .filter((kind, index, all) => all.indexOf(kind) === index)
      .join(", ");
    return {
      ok: false,
      state: "unsupported",
      reason: `${capabilityLabel} action '${action.title}' carries resource operations (${kinds}); only current-file text edits are supported; nothing applied`,
    };
  }
  // LSP `documentChanges` entries arrive as ordered operations while `changes`
  // entries appear in both `documentEdits` and `operations`; operations are
  // authoritative when present, exactly like the canonical applier.
  const documentEntries = operations.length > 0
    ? operations.flatMap((operation) => operation.kind === "text" ? [operation.document] : [])
    : (action.edit.documentEdits ?? []);
  if (documentEntries.length === 0) {
    return {
      ok: false,
      state: "unsupported",
      reason: `${capabilityLabel} action '${action.title}' carried no document edits; nothing applied`,
    };
  }
  const edits: LspTextEdit[] = [];
  for (const entry of documentEntries) {
    const uriMatches = !!entry.uri && entry.uri === targetUri;
    const pathMatches = entry.path != null && fsPathEquals(entry.path, targetPath);
    if (entry.uri && entry.path) {
      if (!uriMatches || !pathMatches) {
        return {
          ok: false,
          state: "unsupported",
          reason: `${capabilityLabel} action '${action.title}' addresses a different or contradictory document (uri ${entry.uri}, path ${entry.path}) instead of ${targetPath}; nothing applied`,
        };
      }
    } else if (entry.uri) {
      if (!uriMatches) {
        return {
          ok: false,
          state: "unsupported",
          reason: `${capabilityLabel} action '${action.title}' edits a different document (${entry.uri}) instead of ${targetUri}; nothing applied`,
        };
      }
    } else if (entry.path) {
      if (!pathMatches) {
        return {
          ok: false,
          state: "unsupported",
          reason: `${capabilityLabel} action '${action.title}' edits a different document (${entry.path}) instead of ${targetPath}; nothing applied`,
        };
      }
    } else {
      return {
        ok: false,
        state: "failed",
        reason: `${capabilityLabel} action '${action.title}' carried a malformed document entry without uri or path; nothing applied`,
      };
    }
    if (
      entry.version != null
      && input.documentRevision != null
      && entry.version !== input.documentRevision
    ) {
      return {
        ok: false,
        state: "stale",
        reason: `${capabilityLabel} action '${action.title}' targets document version ${entry.version} but the live document is at ${input.documentRevision}; nothing applied`,
      };
    }
    edits.push(...entry.edits);
  }
  if (edits.length === 0) {
    return {
      ok: false,
      state: "unsupported",
      reason: `${capabilityLabel} action '${action.title}' carried no usable edits; nothing applied`,
    };
  }
  const lines = input.documentText.split("\n");
  for (const edit of edits) {
    // A real JDT LS sortMembers edit can address positions past the last
    // document line; the canonical applier clamps those exactly like
    // offsetFromLspPositionInString, and the postcondition hash still decides.
    // Only structurally malformed (negative/non-integer) or reversed ranges
    // are rejected here.
    if (!workflowEditRangeIsValid(edit)) {
      const { start, end } = edit.range;
      return {
        ok: false,
        state: "failed",
        reason: `${capabilityLabel} action '${action.title}' carried a malformed or reversed edit range`
          + ` (${start.line}:${start.character} -> ${end.line}:${end.character}, document has ${lines.length} lines); nothing applied`,
      };
    }
  }
  return { ok: true, edits };
}

/**
 * ED-AUDIT-016: production execute wiring for Code Cleanup.
 * ---------------------------------------------------------------------------
 * Mirrors the rearrange execute owner (ED-AUDIT-015): file scope with the
 * default profile only; other scopes/profiles stay unavailable per spec.
 */

/**
 * Provider action kinds that count as a dedicated batch-cleanup capability.
 * Matched by exact kind equality only — never by summary booleans, title
 * substring guessing, or relabeling format/organizeImports as cleanup.
 * ED-IMPROVE-003: generic `source.fixAll` is NOT an equivalent Cleanup kind —
 * without a dedicated cleanup/profile contract a fixAll payload stays
 * unavailable instead of being executed under the Cleanup label.
 * NOTE: Eclipse JDT LS 1.61 exposes no cleanup kind (bundle + live probe
 * verified: only generate/organizeImports/overrideMethods/sortMembers), so
 * this list matches nothing on this box today; the wiring below still
 * performs the real request/resolve/plan/confirm/apply/post-verify chain
 * for any provider that does advertise one of these kinds.
 */
export const CLEANUP_ACTION_KINDS: readonly string[] = [
  "source.cleanup",
  "cleanup",
];

export function isCleanupActionKind(kind: string | null): boolean {
  return kind !== null && CLEANUP_ACTION_KINDS.includes(kind);
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
  | { ok: true; postHash: string; operationCount: number; historyId: string | null }
  | {
    ok: false;
    state: WorkflowExecuteFailureState;
    reason: string;
    effect: WorkflowEffect;
    committed: false;
  };

/**
 * ED-AUDIT-016 + ED-IMPROVE-001 execute owner: zero-IO no-target/readonly/
 * scope pre-gate -> freeze text/generation/token -> request a dedicated
 * cleanup action -> resolve to edits -> plan from the verified frozen
 * preimage -> precondition/freshness gates -> no-change fact -> confirm gate
 * -> post-confirm identity gate -> canonical apply with a final pre-mutation
 * guard -> postcondition verify. Capability support is decided by live
 * discovery (exact kind equality), never by advertised summaries.
 */
export async function executeCleanupTransaction(
  deps: CleanupExecuteDeps,
  input: CleanupExecuteInput,
): Promise<CleanupExecuteResult> {
  const fail = (
    state: WorkflowExecuteFailureState,
    reason: string,
    effect: WorkflowEffect = { kind: "none" },
  ): CleanupExecuteResult => ({ ok: false, state, reason, effect, committed: false });

  // 0. Zero-IO pre-gate: no target, readonly, or non-file scope/profile
  // short-circuits without touching the provider. Scope is fixed to the
  // current file with the default profile per spec; anything else stays
  // unavailable with an exact reason instead of silently narrowing.
  if (!input.targetPath) {
    return fail("unavailable", "No target is selected for code cleanup");
  }
  if (input.readOnly) {
    return fail("conflict", `${input.targetPath} is read-only and cannot be cleaned up`);
  }
  const profileId = input.profileId ?? "default";
  if (input.scope !== "file") {
    return fail("unavailable", `Code Cleanup covers the current file only; ${input.scope} scope is unavailable`);
  }
  if (profileId !== "default") {
    return fail("unavailable", `Cleanup profile '${profileId}' is unavailable; only the default profile is supported`);
  }

  // 1. Freeze every identity before the first await. Same text-anchored
  // discipline as the rearrange owner.
  const frozen = deps.readLive();
  if (!frozen) {
    return fail("cancelled", `${input.targetPath} is no longer open; cleanup cancelled with zero effect`);
  }
  if (frozen.readOnly) {
    return fail("conflict", `${input.targetPath} is read-only and cannot be cleaned up`);
  }
  const frozenGeneration = deps.providerGeneration();
  const frozenToken = deps.requestToken?.();
  const frozenTextSha256 = sha256Hex(frozen.text);
  const guard = buildWorkflowMutationGuard(deps, {
    targetPath: input.targetPath,
    textSha256: frozenTextSha256,
    providerGeneration: frozenGeneration,
    requestToken: frozenToken,
  });
  const guardFailure = (window: string): CleanupExecuteResult | null => {
    const current = guard.check();
    if (current.ok) return null;
    return fail(current.state, `${window} rejected the stale plan: ${current.reason}; nothing applied`);
  };

  // 2. Request dedicated provider actions (the request itself freezes identity).
  const requested = await deps.requestActions();
  if (requested.state !== "ok") {
    return fail(
      mapRequestFailureState(requested.state),
      requested.reason ?? `Cleanup request ${requested.state}; nothing applied`,
    );
  }
  const afterRequest = guardFailure("Cleanup after the provider request");
  if (afterRequest) return afterRequest;

  // 3. Resolve to a callable cleanup-kind action by exact kind equality.
  const action = requested.actions.find((candidate) => isCleanupActionKind(candidate.kind)) ?? null;
  if (!action) {
    const seen = requested.actions
      .map((candidate) => candidate.kind ?? "(no kind)")
      .slice(0, 3)
      .join(", ");
    return fail(
      "unsupported",
      seen
        ? `Provider returned no cleanup action (received kinds: ${seen}). Code Cleanup requires a dedicated batch cleanup provider; nothing applied.`
        : "Provider returned no actions. Code Cleanup requires a dedicated batch cleanup provider; nothing applied.",
    );
  }

  // 4. Resolve the action to concrete edits, then reject if the provider or
  // document identity moved while the resolve was in flight.
  const resolved = await deps.resolveAction(action);
  if (resolved.state !== "resolved") {
    return fail(
      mapResolveFailureState(resolved.state),
      resolved.reason ?? `Cleanup resolve ${resolved.state}; nothing applied`,
    );
  }
  if (resolved.edits.length === 0) {
    return fail("unsupported", `Provider action '${action.title}' carried no edits; nothing applied`);
  }
  const afterResolve = guardFailure("Cleanup after the provider resolve");
  if (afterResolve) return afterResolve;

  // 5. Build the plan from the verified frozen preimage.
  const planLive = deps.readLive();
  if (!planLive) {
    return fail("cancelled", `${input.targetPath} is no longer open; cleanup cancelled with zero effect`);
  }
  if (planLive.readOnly) {
    return fail("conflict", `${input.targetPath} is read-only and cannot be cleaned up`);
  }
  if (sha256Hex(planLive.text) !== frozenTextSha256) {
    return fail("stale", `${input.targetPath} changed since the frozen preimage; request the cleanup again`);
  }
  const plan = buildCleanupPlan({
    scope: "file",
    targetPath: input.targetPath,
    targetUri: input.targetUri,
    currentText: planLive.text,
    documentRevision: undefined,
    readOnly: planLive.readOnly,
    profileId,
    provider: input.capabilities.providerId
      ? { id: input.capabilities.providerId, version: input.capabilities.providerVersion }
      : { id: "provider" },
    edits: resolved.edits,
    isDirty: planLive.dirty,
  });
  if (plan.conflicts.length > 0) {
    return fail("conflict", plan.conflicts[0].message);
  }
  const preconditions = verifyWorkflowPreconditions(plan, {
    [input.targetPath]: { text: planLive.text, readOnly: planLive.readOnly },
    [input.targetUri]: { text: planLive.text, readOnly: planLive.readOnly },
  });
  if (!preconditions.ok) {
    return fail(
      preconditions.conflict?.reason === "read-only" ? "conflict" : "stale",
      preconditions.conflict?.message ?? `${input.targetPath} changed since plan generation; nothing applied`,
    );
  }
  const freshness = verifyWorkflowFreshness(
    { providerGeneration: frozenGeneration },
    { providerGeneration: deps.providerGeneration() },
  );
  if (!freshness.ok) {
    return fail("stale", `Cleanup became stale: ${freshness.staleReason}; request it again`);
  }

  // 6. Preview confirm gate: cancel commits nothing. An empty edit is a
  // no-change fact, reported without claiming fixes were applied.
  const preHash = plan.preconditions[0]?.preTextSha256 ?? frozenTextSha256;
  const postHash = plan.expectedPostHashes[input.targetPath] ?? "";
  if (preHash === postHash) {
    return fail("unavailable", "Cleanup produced no changes; nothing applied");
  }
  const confirmed = await deps.confirmPreview({
    targetPath: input.targetPath,
    profileId,
    operationCount: resolved.edits.length,
    preHashShort: preHash.slice(0, 12),
    postHashShort: postHash.slice(0, 12),
  });
  if (!confirmed) {
    cancelWorkflowPlan(plan);
    return fail("cancelled", "Cleanup cancelled before applying; nothing changed");
  }
  const afterPreview = guardFailure("Cleanup after the preview confirmation");
  if (afterPreview) {
    cancelWorkflowPlan(plan);
    return afterPreview;
  }

  // 7. Canonical apply with the last identity check inside the shared apply
  // boundary, then postcondition verification against real bytes. Mirrors the
  // rearrange owner's journal/history/effect contract.
  const applied = await deps.applyEdit(plan.edit, guard, {
    targetPath: input.targetPath,
    targetUri: input.targetUri,
    preText: planLive.text,
    expectedPostHash: postHash,
  });
  if (applied.state !== "applied" || applied.postText === undefined) {
    // ED-IMPROVE-002: explicit effect facts win over the pre-mutation guard,
    // exactly like the rearrange owner.
    if (applied.state === "unknown-effect") {
      return fail(
        "unknown-effect",
        applied.reason ?? "Cleanup write result is unknown; verify the file before retrying",
        {
          kind: "unknown",
          paths: applied.affectedPaths ?? [input.targetPath],
          recoveryId: applied.recoveryId ?? null,
        },
      );
    }
    if (applied.state === "recovery-required") {
      return fail(
        "recovery-required",
        applied.reason
          ?? "Cleanup applied but its postcondition could not be verified; recover from the pending journal",
        {
          kind: "performed",
          paths: applied.affectedPaths ?? [input.targetPath],
          recoveryId: applied.recoveryId ?? null,
        },
      );
    }
    const current = guard.check();
    if (!current.ok) {
      return fail(
        current.state,
        applied.reason
          ? `${current.reason}: ${applied.reason}`
          : `${current.reason}; nothing applied`,
      );
    }
    const performed = applied.affectedPaths && applied.affectedPaths.length > 0;
    return fail(
      applied.state === "conflict" ? "conflict" : "failed",
      applied.reason ?? "Cleanup apply failed; see the workspace-edit ledger",
      performed
        ? {
          kind: "partial",
          paths: applied.affectedPaths ?? [],
          recoveryId: applied.recoveryId ?? null,
        }
        : { kind: "none" },
    );
  }
  const post = verifyWorkflowPostHashes(plan.expectedPostHashes, {
    [input.targetPath]: applied.postText,
  });
  if (!post.ok) {
    return fail(
      "failed",
      `Cleanup postcondition failed on ${post.mismatchedFiles.join(", ")}; the workspace-edit history/recovery entry owns the applied effects.`,
      { kind: "performed", paths: [input.targetPath], recoveryId: applied.recoveryId ?? null },
    );
  }
  return {
    ok: true,
    postHash: plan.expectedPostHashes[input.targetPath],
    operationCount: resolved.edits.length,
    historyId: applied.historyId ?? null,
  };
}
