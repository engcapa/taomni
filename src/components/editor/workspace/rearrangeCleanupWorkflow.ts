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

export type RearrangeApplyState = "applied" | "failed" | "conflict";

export interface RearrangeApplyResult {
  state: RearrangeApplyState;
  postText?: string;
  reason?: string;
}

export interface RearrangeExecuteDeps {
  requestActions(): Promise<RearrangeRequestResult>;
  resolveAction(action: RearrangeProviderAction): Promise<RearrangeResolveResult>;
  readLive(): RearrangeLiveDocument | null;
  providerGeneration(): number;
  confirmPreview(summary: RearrangePreviewSummary): Promise<boolean>;
  applyEdit(edit: LspWorkspaceEdit): Promise<RearrangeApplyResult>;
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
  | { ok: true; postHash: string; operationCount: number }
  | { ok: false; reason: string; committed: false };

/**
 * ED-AUDIT-015 execute owner: gate -> freeze text/provider-generation ->
 * request a dedicated rearrange action -> resolve to edits -> re-read live
 * and plan with preview data -> precondition/freshness gates -> confirm gate
 * -> canonical apply -> postcondition verify. Every early return commits
 * nothing; only a post-hash-verified apply returns ok:true.
 *
 * Revision pinning is deliberately text-anchored, not revision-anchored: a
 * background LSP sync may bump the document revision without changing a
 * byte (observed: 0 -> 1 on open), and refusing that would be a false
 * stale. The plan carries no pinned revision, so the applier's version gate
 * is bypassed by design; instead the frozen text hash is re-verified
 * immediately before apply, and the postcondition hash after it. A
 * same-text revision bump is therefore harmless, while any byte change
 * refuses. Supported-branch callers MUST mark test-double coverage as
 * model-boundary: only a live capable provider proves the provider half of
 * this chain.
 */
export async function executeRearrangeTransaction(
  deps: RearrangeExecuteDeps,
  input: RearrangeExecuteInput,
): Promise<RearrangeExecuteResult> {
  const fail = (reason: string): RearrangeExecuteResult => ({ ok: false, reason, committed: false });

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
    return fail("No file is open to rearrange");
  }
  if (input.readOnly) {
    return fail(`${input.targetPath} is read-only and cannot be rearranged`);
  }
  const decision = {
    scope: requestedScope,
    provider: input.capabilities.providerId
      ? { id: input.capabilities.providerId, version: input.capabilities.providerVersion }
      : undefined,
  };

  // 1. Freeze the live text for closed/readonly gating. The preimage used by
  // the plan is re-read after resolve (step 5) so a benign background sync
  // between request and plan never trips a false stale.
  const frozen = deps.readLive();
  if (!frozen) {
    return fail(`${input.targetPath} is no longer open; rearrange cancelled with zero effect`);
  }
  if (frozen.readOnly) {
    return fail(`${input.targetPath} is read-only and cannot be rearranged`);
  }
  const frozenGeneration = deps.providerGeneration();

  // 2. Request dedicated provider actions (the request itself freezes identity).
  const requested = await deps.requestActions();
  if (requested.state !== "ok") {
    return fail(requested.reason ?? `Rearrange request ${requested.state}; nothing applied`);
  }

  // 3. Resolve to a callable rearrange-kind action by exact kind equality.
  const action = requested.actions.find((candidate) => isRearrangeActionKind(candidate.kind)) ?? null;
  if (!action) {
    const seen = requested.actions
      .map((candidate) => candidate.kind ?? "(no kind)")
      .slice(0, 3)
      .join(", ");
    return fail(
      seen
        ? `Provider returned no rearrange action (received kinds: ${seen}). Rearrange Code requires a dedicated arrangement provider; nothing applied.`
        : "Provider returned no actions. Rearrange Code requires a dedicated arrangement provider; nothing applied.",
    );
  }

  // 4. Resolve the action to concrete edits.
  const resolved = await deps.resolveAction(action);
  if (resolved.state !== "resolved") {
    return fail(resolved.reason ?? `Rearrange resolve ${resolved.state}; nothing applied`);
  }
  if (resolved.edits.length === 0) {
    return fail(`Provider action '${action.title}' carried no edits; nothing applied`);
  }

  // 5. Re-read live and build the plan from post-resolve bytes with preview
  // data. No pinned revision travels into the plan: the text hash below is
  // the ground truth, and a same-text revision bump re-anchors silently.
  const planLive = deps.readLive();
  if (!planLive) {
    return fail(`${input.targetPath} is no longer open; rearrange cancelled with zero effect`);
  }
  if (planLive.readOnly) {
    return fail(`${input.targetPath} is read-only and cannot be rearranged`);
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
    return fail(plan.conflicts[0].message);
  }
  const live = deps.readLive();
  if (!live) {
    return fail(`${input.targetPath} is no longer open; rearrange cancelled with zero effect`);
  }
  const preconditions = verifyWorkflowPreconditions(plan, {
    [input.targetPath]: { text: live.text, readOnly: live.readOnly },
    [input.targetUri]: { text: live.text, readOnly: live.readOnly },
  });
  if (!preconditions.ok) {
    return fail(preconditions.conflict?.message ?? `${input.targetPath} changed since plan generation; nothing applied`);
  }
  const freshness = verifyWorkflowFreshness(
    { providerGeneration: frozenGeneration },
    { providerGeneration: deps.providerGeneration() },
  );
  if (!freshness.ok) {
    return fail(`Rearrange became stale: ${freshness.staleReason}; request it again`);
  }

  // 6. Preview confirm gate: cancel commits nothing.
  const preHash = plan.preconditions[0]?.preTextSha256 ?? sha256Hex(frozen.text);
  const postHash = plan.expectedPostHashes[input.targetPath] ?? "";
  const confirmed = await deps.confirmPreview({
    targetPath: input.targetPath,
    operationCount: resolved.edits.length,
    preHashShort: preHash.slice(0, 12),
    postHashShort: postHash.slice(0, 12),
  });
  if (!confirmed) {
    cancelWorkflowPlan(plan);
    return fail("Rearrange cancelled before applying; nothing changed");
  }

  // 7. Canonical apply, then postcondition verification against real bytes.
  const applied = await deps.applyEdit(plan.edit);
  if (applied.state !== "applied" || applied.postText === undefined) {
    return fail(applied.reason ?? "Rearrange apply failed; see the workspace-edit ledger");
  }
  const post = verifyWorkflowPostHashes(plan.expectedPostHashes, {
    [input.targetPath]: applied.postText,
  });
  if (!post.ok) {
    return fail(
      `Rearrange postcondition failed on ${post.mismatchedFiles.join(", ")}; applied effects are listed for recovery. Undo was not registered.`,
    );
  }
  return { ok: true, postHash: plan.expectedPostHashes[input.targetPath], operationCount: resolved.edits.length };
}
