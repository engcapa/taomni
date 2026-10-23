import type { LspCodeAction, LspWorkspaceEdit } from "../../../../lib/editor/lsp";
import { sha256Hex } from "../projectAnalysisModel";
import type { WorkspaceEditApplyOutcome } from "../workspaceEditApply";
import {
  type CodeActionContextIdentity,
  type CodeActionProviderClient,
  type CodeActionProviderResultV4,
  type CodeActionCandidate,
  type CodeActionResolveOutcome,
  type ImmutableCodeActionPlan,
  type PlanOnlyCodeActionResult,
  type CodeActionApplyHooks,
  type CodeActionPlanPreview,
  type CodeActionApplyOutcome,
  type CodeActionUriHashState,
} from "./types";
import { snapshotCodeActionContext, cloneAndDeepFreeze, isCommandAllowed, computeStableActionId } from "./identity";
import { evaluateCodeActionResult, buildCodeActionParams } from "./provider";
import { requestCandidateActions } from "./requestCandidates";
import {
  extractAffectedUrisFromWorkspaceEdit,
  verifyCodeActionApplyIdentity,
  captureCodeActionSnapshot,
  previewFromSnapshot,
  codeActionSnapshotMismatch,
  restoreAndVerifyCodeActionSnapshot,
  errorMessage,
  codeActionSnapshotHash,
} from "./snapshots";

/**
 * §8.21.4 Canonical Code Action Service (§ED-ACTION-001).
 * Single authoritative pipeline for:
 * `capability -> request -> stable id -> resolve -> immutable plan`
 */
export class CanonicalCodeActionService {
  /**
   * Pipeline step 1 & 2: Capability check & Request execution -> Typed candidates with stable IDs.
   */
  async requestCandidates(
    context: CodeActionContextIdentity,
    client: CodeActionProviderClient,
    options: { timeoutMs?: number; signal?: AbortSignal; } = {},
  ): Promise<CodeActionProviderResultV4> {
    const frozenContext = snapshotCodeActionContext(context);
    const { document, provider, range, diagnostics, only } = frozenContext;
    const timeoutMs = options.timeoutMs ?? 10_000;

    const evidenceInput = {
      languageId: document.languageId,
      provider: { id: provider.id, version: provider.version ?? "1.0.0", generation: provider.generation },
      projectFingerprint: provider.projectFingerprint,
      uri: document.uri,
      revision: document.revision,
    };

    // Unknown or plaintext files must never default to Java provider (§ED-ACTION-001)
    if (document.languageId === "plaintext" && provider.id === "jdtls") {
      return evaluateCodeActionResult(
        { kind: "unsupported", reason: "Java language server cannot serve plaintext documents" },
        evidenceInput,
      );
    }

    if (provider.trusted === false) {
      return evaluateCodeActionResult(
        { kind: "unsupported", reason: "Code actions from untrusted provider are disabled" },
        evidenceInput,
      );
    }

    if (client.checkCapability) {
      const cap = client.checkCapability();
      if (!cap.supported) {
        return evaluateCodeActionResult(
          { kind: "unsupported", reason: cap.reason ?? "Code actions unsupported by provider" },
          evidenceInput,
        );
      }
    }

    const params = buildCodeActionParams(document.uri, range, diagnostics, only);
    const requestId = `ca-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    if (options.signal?.aborted) {
      return evaluateCodeActionResult(
        { kind: "cancelled", requestId, reason: "aborted", providerStillHealthy: true },
        evidenceInput,
      );
    }

    const requestAbort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let rejectCancellation!: (reason: Error) => void;
    const cancellationPromise = new Promise<never>((_, reject) => {
      rejectCancellation = reject;
    });
    const onAbort = () => {
      rejectCancellation(new Error("CODE_ACTION_CANCELLED"));
      requestAbort.abort();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const resultPromise = requestCandidateActions(client, params, provider.id, requestAbort.signal);
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("CODE_ACTION_TIMEOUT"));
          requestAbort.abort();
        }, timeoutMs);
      });
      const rawActions = await Promise.race([
        resultPromise,
        timeoutPromise,
        cancellationPromise,
      ]);

      if (!rawActions) {
        return evaluateCodeActionResult({ kind: "empty", reason: "null-response" }, evidenceInput);
      }

      // Filter out malformed actions (e.g. missing or non-string title)
      const validActions = rawActions.filter((a): a is LspCodeAction => {
        return a != null && typeof a === "object" && typeof a.title === "string" && a.title.trim().length > 0;
      });
      const malformedCount = rawActions.length - validActions.length;
      if (validActions.length === 0 && malformedCount > 0) {
        return evaluateCodeActionResult({
          kind: "malformed",
          malformedCount,
          message: `Provider returned ${malformedCount} malformed code action${malformedCount === 1 ? "" : "s"}`,
        }, evidenceInput);
      }

      return evaluateCodeActionResult({
        kind: "ready",
        actions: validActions.map((action) => cloneAndDeepFreeze(action)),
        discardedMalformedCount: malformedCount,
      }, evidenceInput);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "CODE_ACTION_CANCELLED") {
        return evaluateCodeActionResult(
          { kind: "cancelled", requestId, reason: "aborted", providerStillHealthy: true },
          evidenceInput,
        );
      }
      // ED-PARITY-007 DEC-05: a provider-side cancellation is not a generic
      // failure. JDT LS / the Rust bridge cancel pending requests with
      // "language server request cancelled: document changed" when a didChange
      // supersedes them.
      if (message.includes("document changed")) {
        return evaluateCodeActionResult(
          {
            kind: "cancelled",
            requestId,
            reason: "aborted",
            providerStillHealthy: true,
            detail: message,
          },
          evidenceInput,
        );
      }
      if (
        message === "CODE_ACTION_TIMEOUT"
        || message.includes("timeout")
        || message.includes("Timeout")
        || message.includes("timed out")
      ) {
        return evaluateCodeActionResult(
          {
            kind: "timeout",
            requestId,
            cancelled: true,
            providerStillHealthy: true,
            retryAfter: "manual",
          },
          evidenceInput,
        );
      }
      return evaluateCodeActionResult(
        {
          kind: "failed",
          message: `Code action request failed: ${message}`,
          providerStillHealthy: true,
        },
        evidenceInput,
      );
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Pipeline step 3 & 4: Resolve & Immutable Plan generation.
   */
  async resolvePlan(
    candidate: CodeActionCandidate,
    context: CodeActionContextIdentity,
    client: CodeActionProviderClient,
    currentDocumentRevision: number,
    currentProviderGeneration: number,
    options: { timeoutMs?: number; allowedCommands?: readonly string[]; } = {},
  ): Promise<CodeActionResolveOutcome> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const frozenContext = snapshotCodeActionContext(context);
    const frozenCandidate = cloneAndDeepFreeze(candidate);
    const { document, provider } = frozenContext;

    // Check for stale document or provider generation (§ED-ACTION-001)
    if (currentDocumentRevision !== document.revision) {
      return {
        state: "stale",
        reason: `Document revision changed from ${document.revision} to ${currentDocumentRevision}`,
      };
    }
    if (currentProviderGeneration !== provider.generation) {
      return {
        state: "stale",
        reason: `Provider generation changed from ${provider.generation} to ${currentProviderGeneration}`,
      };
    }

    if (provider.trusted === false) {
      return { state: "rejected", reason: "untrusted" };
    }

    // Java language guard
    const isJavaSpecific =
      Boolean(frozenCandidate.kind?.startsWith("quickfix.import.java")) ||
      Boolean(frozenCandidate.rawAction.command?.includes("_java.")) ||
      Boolean(frozenCandidate.rawAction.command?.includes("java."));
    if (isJavaSpecific && document.languageId !== "java") {
      return { state: "rejected", reason: "language-mismatch" };
    }

    let resolvedAction = frozenCandidate.rawAction;
    if (frozenCandidate.resolveRequired && client.resolveCodeAction) {
      try {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const resolvePromise = client.resolveCodeAction(frozenCandidate.rawAction);
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("RESOLVE_TIMEOUT")), timeoutMs);
        });

        const outcome = await Promise.race([resolvePromise, timeoutPromise]).finally(() => {
          if (timer) clearTimeout(timer);
        });

        if (outcome) {
          resolvedAction = outcome;
        } else {
          return { state: "unresolved", reason: "Provider returned null on resolve", retryable: true };
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          state: "unresolved",
          reason: `Resolve failed: ${message}`,
          retryable: !message.includes("stale"),
        };
      }
    }

    // Extract edit & command
    let effectiveEdit = resolvedAction.edit ?? null;
    let effectiveCommand: { command: string; arguments?: unknown[]; } | null = null;

    if (resolvedAction.command) {
      const args = resolvedAction.commandArguments;
      effectiveCommand = {
        command: resolvedAction.command,
        arguments: Array.isArray(args) ? args : args !== null && args !== undefined ? [args] : undefined,
      };
    }

    // Unpack workspaceEdit embedded in commandArguments if applicable
    const isApplyEditCommand =
      effectiveCommand?.command === "_java.apply.workspaceEdit" ||
      effectiveCommand?.command === "java.apply.workspaceEdit" ||
      effectiveCommand?.command === "editor.action.applyWorkspaceEdit" ||
      effectiveCommand?.command === "applyWorkspaceEdit";

    if (!effectiveEdit && isApplyEditCommand && Array.isArray(effectiveCommand?.arguments)) {
      const firstArg = effectiveCommand.arguments[0] as Record<string, unknown> | undefined;
      if (firstArg && (firstArg.changes || firstArg.documentChanges || firstArg.documentEdits || firstArg.operations)) {
        effectiveEdit = firstArg as unknown as LspWorkspaceEdit;
        effectiveCommand = null;
      }
    }

    // If there is a command remaining, validate against command allowlist
    if (effectiveCommand && !isCommandAllowed(effectiveCommand.command, options.allowedCommands)) {
      return { state: "rejected", reason: "command-disallowed" };
    }

    const plan = cloneAndDeepFreeze<ImmutableCodeActionPlan>({
      actionId: frozenCandidate.id,
      title: resolvedAction.title || frozenCandidate.title,
      kind: resolvedAction.kind || frozenCandidate.kind,
      document,
      provider,
      edit: effectiveEdit,
      command: effectiveCommand,
      evidence: frozenCandidate.evidence ?? null,
      createdAt: Date.now(),
    });

    return { state: "resolved", plan };
  }

  /**
   * Plan-only execution mode (§ED-ACTION-003).
   * Retrieves and resolves code actions (e.g. organizeImports) into an immutable plan
   * without applying any live buffer mutations, disk writes, or undo history entries.
   */
  async planAction(
    context: CodeActionContextIdentity,
    client: CodeActionProviderClient,
    options: {
      only?: readonly string[];
      timeoutMs?: number;
      allowedCommands?: readonly string[];
    } = {},
  ): Promise<PlanOnlyCodeActionResult> {
    const reqContext = options.only ? { ...context, only: options.only } : context;
    const reqRes = await this.requestCandidates(reqContext, client, { timeoutMs: options.timeoutMs });

    if (reqRes.state !== "ready" || reqRes.actions.length === 0) {
      let reason: string;
      if (reqRes.state === "unsupported") reason = reqRes.reason;
      else if (reqRes.state === "failed" || reqRes.state === "malformed") reason = reqRes.message;
      else if (reqRes.state === "empty") reason = "Provider returned a null code-action response";
      else if (reqRes.state === "timeout") reason = "Code-action request timed out";
      else if (reqRes.state === "cancelled") reason = "Code-action request was cancelled";
      else reason = "No actions returned";
      return {
        plan: null,
        requestState: reqRes.state,
        outcome: {
          state: "unresolved",
          reason,
          retryable: reqRes.state === "timeout" || reqRes.state === "cancelled",
        },
        effectCounters: { liveEdits: 0, diskWrites: 0, historyEntries: 0, commands: 0 },
      };
    }

    // Pick first matching or preferred action
    const providerAction = reqRes.actions.find((a) => a.action.isPreferred) ?? reqRes.actions[0]!;
    const candidate: CodeActionCandidate = {
      id: computeStableActionId(providerAction.action, context.provider.id),
      title: providerAction.action.title,
      kind: providerAction.action.kind ?? "",
      isPreferred: providerAction.action.isPreferred,
      disabledReason: providerAction.disabledReason,
      resolveRequired: Boolean(providerAction.action.raw && typeof providerAction.action.raw === "object" && "data" in providerAction.action.raw),
      rawAction: providerAction.action,
      evidence: providerAction.evidence,
    };

    const resolveOutcome = await this.resolvePlan(
      candidate,
      context,
      client,
      context.document.revision,
      context.provider.generation,
      { timeoutMs: options.timeoutMs, allowedCommands: options.allowedCommands },
    );

    return {
      plan: resolveOutcome.state === "resolved" ? resolveOutcome.plan : null,
      requestState: reqRes.state,
      outcome: resolveOutcome,
      effectCounters: { liveEdits: 0, diskWrites: 0, historyEntries: 0, commands: 0 },
    };
  }

  /**
   * Preview a resolved code action plan (§ED-ACTION-004).
   * Extracts affected URIs and computes pre-apply content hashes.
   */
  previewPlan(
    plan: ImmutableCodeActionPlan,
    hooks: Pick<CodeActionApplyHooks, "getLiveDocumentText">,
  ): CodeActionPlanPreview {
    const uris = extractAffectedUrisFromWorkspaceEdit(plan.edit);
    if (uris.length === 0) uris.push(plan.document.uri);

    const preHashes: Record<string, string> = {};
    for (const uri of uris) {
      const text = hooks.getLiveDocumentText(uri) ?? "";
      preHashes[uri] = sha256Hex(text);
    }

    return {
      plan,
      affectedUris: Object.freeze(uris),
      requiresConfirmation: uris.length > 1,
      preHashes: Object.freeze(preHashes),
    };
  }

  /**
   * Apply a resolved code action plan through preview -> commit -> postcondition -> history (§ED-ACTION-004).
   */
  async applyPlan(
    plan: ImmutableCodeActionPlan,
    hooks: CodeActionApplyHooks,
    options: { signal?: AbortSignal; } = {},
  ): Promise<CodeActionApplyOutcome> {
    const startTime = Date.now();
    if (options.signal?.aborted) {
      return { status: "cancelled", reason: "Operation cancelled before execution" };
    }

    const initialIdentity = verifyCodeActionApplyIdentity(plan, hooks);
    if (!initialIdentity.valid) {
      return {
        status: initialIdentity.status,
        reason: initialIdentity.reason,
        affectedUris: extractAffectedUrisFromWorkspaceEdit(plan.edit),
      };
    }

    const affectedUris = extractAffectedUrisFromWorkspaceEdit(plan.edit);
    if (affectedUris.length === 0 && plan.edit) affectedUris.push(plan.document.uri);
    if (plan.edit && (!hooks.captureSnapshot || !hooks.restoreSnapshot || !hooks.registerHistoryEntry)) {
      return {
        status: "failed",
        error: "Canonical workspace-edit snapshot/history hooks are unavailable",
        affectedUris,
      };
    }

    const beforeSnapshot = plan.edit
      ? await captureCodeActionSnapshot(hooks, plan.edit)
      : null;
    if (plan.edit && !beforeSnapshot) {
      return {
        status: "failed",
        error: "Cannot capture every affected workspace resource before preview",
        affectedUris,
      };
    }
    const preview = beforeSnapshot
      ? previewFromSnapshot(plan, beforeSnapshot)
      : this.previewPlan(plan, hooks);
    const historyCandidateId = `ca-hist-${sha256Hex(`${plan.actionId}:${Date.now()}`).slice(0, 16)}`;
    const recoveryCandidateId = `ca-rec-${sha256Hex(`${plan.actionId}:${plan.document.uri}:${Date.now()}`).slice(0, 16)}`;

    let outcomes: WorkspaceEditApplyOutcome[] = [];
    let appliedEdit = plan.edit;
    const recoverMutation = async (error: string): Promise<CodeActionApplyOutcome> => {
      if (!plan.edit || !beforeSnapshot || !hooks.captureSnapshot || !hooks.restoreSnapshot) {
        return { status: "failed", error, affectedUris, outcomes };
      }

      const partialSnapshot = await captureCodeActionSnapshot(hooks, plan.edit);
      if (!partialSnapshot) {
        return {
          status: "failed",
          error,
          affectedUris,
          outcomes,
          recoveryId: recoveryCandidateId,
          recoveryState: "unavailable",
        };
      }
      const mutated = codeActionSnapshotMismatch(beforeSnapshot, partialSnapshot) !== null;
      if (!mutated) return { status: "failed", error, affectedUris, outcomes };
      const recover = async () => restoreAndVerifyCodeActionSnapshot(
        plan.edit!,
        partialSnapshot,
        beforeSnapshot,
        hooks,
      );
      try {
        await recover();
        return {
          status: "failed",
          error,
          affectedUris,
          outcomes,
          recoveryId: recoveryCandidateId,
          recoveryState: "performed",
        };
      } catch (recoveryError) {
        if (hooks.registerRecoveryEntry) {
          hooks.registerRecoveryEntry({
            id: recoveryCandidateId,
            label: plan.title,
            affectedUris: [...affectedUris],
            recover,
          });
          return {
            status: "failed",
            error: `${error}; automatic recovery failed: ${errorMessage(recoveryError)}`,
            affectedUris,
            outcomes,
            recoveryId: recoveryCandidateId,
            recoveryState: "registered",
          };
        }
        return {
          status: "failed",
          error: `${error}; automatic recovery failed: ${errorMessage(recoveryError)}`,
          affectedUris,
          outcomes,
          recoveryId: recoveryCandidateId,
          recoveryState: "unavailable",
        };
      }
    };

    if (plan.edit) {
      try {
        const applyResult = await hooks.applyWorkspaceEdit(plan.edit, {
          historyId: historyCandidateId,
          recoveryId: recoveryCandidateId,
          onBeforeCommit: async () => {
            if (options.signal?.aborted) {
              throw new Error("CODE_ACTION_CANCELLED: operation cancelled after preview");
            }
            const identity = verifyCodeActionApplyIdentity(plan, hooks);
            if (!identity.valid) {
              throw new Error(`CODE_ACTION_${identity.status.toUpperCase()}: ${identity.reason}`);
            }
            const liveSnapshot = await captureCodeActionSnapshot(hooks, plan.edit!);
            if (!liveSnapshot) {
              throw new Error("CODE_ACTION_CONFLICT: affected resources could not be re-read after preview");
            }
            const mismatch = codeActionSnapshotMismatch(beforeSnapshot!, liveSnapshot);
            if (mismatch) {
              throw new Error(`CODE_ACTION_CONFLICT: ${mismatch}`);
            }
          },
        });
        if (Array.isArray(applyResult)) {
          outcomes = applyResult;
        } else {
          outcomes = [...applyResult.outcomes];
          appliedEdit = applyResult.appliedEdit;
        }
        const rejected = outcomes.find((outcome) => (
          outcome.status === "failed" || outcome.status === "skipped"
        ));
        if (rejected) {
          if (rejected.operationIndex === null && !outcomes.some((outcome) => outcome.status.startsWith("applied"))) {
            if (rejected.status === "skipped") {
              return { status: "cancelled", reason: rejected.reason };
            }
            if (rejected.reason.startsWith("CODE_ACTION_CANCELLED:")) {
              return { status: "cancelled", reason: rejected.reason.slice("CODE_ACTION_CANCELLED:".length).trim() };
            }
            if (rejected.reason.startsWith("CODE_ACTION_STALE:")) {
              return {
                status: "stale",
                reason: rejected.reason.slice("CODE_ACTION_STALE:".length).trim(),
                affectedUris,
              };
            }
            if (rejected.reason.startsWith("CODE_ACTION_CONFLICT:")) {
              return {
                status: "conflict",
                reason: rejected.reason.slice("CODE_ACTION_CONFLICT:".length).trim(),
                affectedUris,
              };
            }
          }
          return recoverMutation(rejected.reason || "WorkspaceEdit apply failed");
        }
      } catch (err: unknown) {
        return recoverMutation(`Failed to apply workspace edit: ${errorMessage(err)}`);
      }
    }

    if (plan.command && hooks.executeCommand) {
      try {
        await hooks.executeCommand(plan.command.command, plan.command.arguments);
      } catch (err: unknown) {
        return recoverMutation(`Provider command execution failed: ${errorMessage(err)}`);
      }
    }

    const afterSnapshot = plan.edit && hooks.captureSnapshot
      ? await captureCodeActionSnapshot(hooks, plan.edit)
      : null;
    if (appliedEdit && !afterSnapshot) {
      return recoverMutation("Cannot read every affected workspace resource after commit");
    }

    const changed = beforeSnapshot && afterSnapshot
      ? codeActionSnapshotMismatch(beforeSnapshot, afterSnapshot) !== null
      : false;
    const uriHashes: Record<string, CodeActionUriHashState> = {};
    const committedUris = appliedEdit
      ? extractAffectedUrisFromWorkspaceEdit(appliedEdit)
      : affectedUris;
    for (const uri of committedUris) {
      const preHash = preview.preHashes[uri]
        ?? codeActionSnapshotHash(beforeSnapshot?.resources.find((resource) => resource.uri === uri));
      const postHash = codeActionSnapshotHash(afterSnapshot?.resources.find((resource) => resource.uri === uri));
      uriHashes[uri] = Object.freeze({
        uri,
        preHash,
        postHash,
        undoHash: preHash,
      });
    }

    let historyId: string | null = null;
    if (changed && plan.edit && appliedEdit && beforeSnapshot && afterSnapshot) {
      historyId = historyCandidateId;
      hooks.registerHistoryEntry!({
        id: historyId,
        label: plan.title,
        affectedUris: [...committedUris],
        undo: () => restoreAndVerifyCodeActionSnapshot(
          plan.edit!,
          afterSnapshot,
          beforeSnapshot,
          hooks,
        ),
        redo: () => restoreAndVerifyCodeActionSnapshot(
          plan.edit!,
          beforeSnapshot,
          afterSnapshot,
          hooks,
        ),
      });
    }

    return {
      status: "applied",
      plan,
      historyId,
      recoveryId: null,
      affectedUris: committedUris,
      uriHashes: Object.freeze(uriHashes),
      outcomes: Object.freeze(outcomes),
      durationMs: Date.now() - startTime,
    };
  }
}
