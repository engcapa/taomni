import { sha256Hex } from "../projectAnalysisModel";
import { type CleanupExecuteDeps, type CleanupExecuteInput, type CleanupExecuteResult, type WorkflowExecuteFailureState, type WorkflowEffect } from "./types";
import { buildWorkflowMutationGuard, mapRequestFailureState, mapResolveFailureState } from "./mutationGuard";
import { selectEnabledWorkflowAction, formatWorkflowDisabledReason } from "./actionValidation";
import { isCleanupActionKind } from "./capabilities";
import { buildCleanupPlan, verifyWorkflowPreconditions, verifyWorkflowFreshness, cancelWorkflowPlan, verifyWorkflowPostHashes } from "./plans";

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
  // ED-MAIN-002: request-stage disabled refusal, before resolve/preview/commit.
  const selection = selectEnabledWorkflowAction(requested.actions, isCleanupActionKind);
  if (!selection.action) {
    if (selection.disabled) {
      return fail(
        "unsupported",
        `Cleanup action '${selection.disabled.action.title}' is disabled by the provider`
        + `${formatWorkflowDisabledReason(selection.disabled.reason)}; nothing applied`,
      );
    }
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
  const action = selection.action;

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
    documentVersion: resolved.documentVersion ?? null,
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
