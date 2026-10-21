import { sha256Hex } from "../projectAnalysisModel";
import {
  type RearrangeExecuteDeps,
  type RearrangeExecuteInput,
  type RearrangeExecuteResult,
  type WorkflowExecuteFailureState,
  type WorkflowEffect,
} from "./types";
import { buildWorkflowMutationGuard, mapRequestFailureState, mapResolveFailureState } from "./mutationGuard";
import { selectEnabledWorkflowAction, formatWorkflowDisabledReason } from "./actionValidation";
import { isRearrangeActionKind } from "./capabilities";
import { buildRearrangePlan, verifyWorkflowPreconditions, verifyWorkflowFreshness, cancelWorkflowPlan, verifyWorkflowPostHashes } from "./plans";

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
  // ED-MAIN-002: a provider-disabled candidate is refused here, before any
  // resolve/preview/commit; a same-kind enabled candidate still wins.
  const selection = selectEnabledWorkflowAction(requested.actions, isRearrangeActionKind);
  if (!selection.action) {
    if (selection.disabled) {
      return fail(
        "unsupported",
        `Rearrange action '${selection.disabled.action.title}' is disabled by the provider`
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
        ? `Provider returned no rearrange action (received kinds: ${seen}). Rearrange Code requires a dedicated arrangement provider; nothing applied.`
        : "Provider returned no actions. Rearrange Code requires a dedicated arrangement provider; nothing applied.",
    );
  }
  const action = selection.action;

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
    documentVersion: resolved.documentVersion ?? null,
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
