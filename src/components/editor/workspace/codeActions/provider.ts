import type { LspCodeAction, LspDiagnostic, LspRange } from "../../../../lib/editor/lsp";
import { buildCapabilityEvidence, type BuildEvidenceInput } from "../capabilityEvidence";
import { type ProviderActionV4, type CodeActionProviderResultV4 } from "./types";

/**
 * Canonical CodeAction request parameter builder (§8.21.4).
 * Shared between production adapter and fixture runner to guarantee
 * identical client protocol payloads.
 */
export function buildCodeActionParams(
  uri: string,
  range: LspRange,
  diagnostics: readonly LspDiagnostic[],
  only?: readonly string[] | null,
): {
  textDocument: { uri: string; };
  range: LspRange;
  context: {
    diagnostics: readonly LspDiagnostic[];
    only?: readonly string[];
  };
} {
  const filteredOnly = only && only.length > 0
    ? only.map((k) => k.trim()).filter(Boolean)
    : undefined;
  return {
    textDocument: { uri },
    range,
    context: {
      diagnostics,
      ...(filteredOnly && filteredOnly.length > 0 ? { only: filteredOnly } : {}),
    },
  };
}

/**
 * Standard client capabilities for code action negotiation (§8.21.4).
 */
export function buildCodeActionClientCapabilities(): Record<string, unknown> {
  return {
    dynamicRegistration: true,
    codeActionLiteralSupport: {
      codeActionKind: {
        valueSet: [
          "",
          "quickfix",
          "refactor",
          "refactor.extract",
          "refactor.inline",
          "refactor.rewrite",
          "source",
          "source.organizeImports",
          "source.fixAll",
        ],
      },
    },
    isPreferredSupport: true,
    dataSupport: true,
    resolveSupport: {
      properties: ["edit", "command"],
    },
  };
}

/**
 * LSP 3.16 `CodeAction.disabled`: the server can return an action it would
 * refuse, with the reason. Such a candidate renders as a disabled menu entry
 * instead of an action that only fails after the user selects it.
 */
export function providerDeclaredDisabledReason(action: LspCodeAction): string | null {
  const disabled = (action.raw as { disabled?: { reason?: unknown; }; } | null | undefined)?.disabled;
  const reason = disabled?.reason;
  return typeof reason === "string" && reason.trim().length > 0 ? reason : null;
}

/**
 * Maps raw provider actions into ProviderActionV4 with evidence.
 */
export function toProviderActionsV4(
  actions: readonly LspCodeAction[],
  evidenceInput: Omit<BuildEvidenceInput, "capabilityId" | "complete" | "reason">,
  disabledReason: string | null = null,
): ProviderActionV4[] {
  const evidence = buildCapabilityEvidence({
    ...evidenceInput,
    capabilityId: "codeAction.intention",
    complete: true,
    reason: "provider code actions returned for diagnostic context",
  });
  return actions.map((action) => ({
    action,
    evidence,
    disabledReason: disabledReason ?? providerDeclaredDisabledReason(action),
  }));
}

/**
 * Evaluates provider result into CodeActionProviderResultV4 envelope.
 */
export function evaluateCodeActionResult(
  outcome:
    | { kind: "ready"; actions: readonly LspCodeAction[]; discardedMalformedCount?: number; }
    | { kind: "empty"; reason: "null-response"; }
    | { kind: "malformed"; malformedCount: number; message: string; }
    | { kind: "unsupported"; reason: string; }
    | { kind: "timeout"; requestId: string; cancelled: boolean; providerStillHealthy: boolean; retryAfter: "manual" | "restart"; }
    | { kind: "cancelled"; requestId: string; reason: "aborted"; providerStillHealthy: boolean; detail?: string; }
    | { kind: "failed"; message: string; providerStillHealthy: boolean; },
  evidenceInput: Omit<BuildEvidenceInput, "capabilityId" | "complete" | "reason">,
): CodeActionProviderResultV4 {
  if (outcome.kind === "ready") {
    const evidence = buildCapabilityEvidence({
      ...evidenceInput,
      capabilityId: "codeAction.intention",
      complete: true,
      reason: "provider code actions returned",
    });
    return {
      state: "ready",
      actions: toProviderActionsV4(outcome.actions, evidenceInput),
      evidence,
      discardedMalformedCount: outcome.discardedMalformedCount ?? 0,
    };
  }
  if (outcome.kind === "empty") {
    const evidence = buildCapabilityEvidence({
      ...evidenceInput,
      capabilityId: "codeAction.intention",
      complete: false,
      reason: "provider returned null instead of a code-action array",
    });
    return { state: "empty", reason: outcome.reason, evidence };
  }
  if (outcome.kind === "malformed") {
    const evidence = buildCapabilityEvidence({
      ...evidenceInput,
      capabilityId: "codeAction.intention",
      complete: false,
      reason: outcome.message,
    });
    return {
      state: "malformed",
      message: outcome.message,
      malformedCount: outcome.malformedCount,
      providerStillHealthy: true,
      evidence,
    };
  }
  if (outcome.kind === "unsupported") {
    const evidence = buildCapabilityEvidence({
      ...evidenceInput,
      capabilityId: "codeAction.intention",
      complete: false,
      reason: outcome.reason,
    });
    return {
      state: "unsupported",
      reason: outcome.reason,
      evidence,
    };
  }
  if (outcome.kind === "timeout") {
    return {
      state: "timeout",
      requestId: outcome.requestId,
      cancelled: outcome.cancelled,
      providerStillHealthy: outcome.providerStillHealthy,
      retryAfter: outcome.retryAfter,
    };
  }
  if (outcome.kind === "cancelled") {
    return {
      state: "cancelled",
      requestId: outcome.requestId,
      reason: outcome.reason,
      providerStillHealthy: outcome.providerStillHealthy,
      ...(outcome.detail ? { detail: outcome.detail } : {}),
    };
  }
  return {
    state: "failed",
    message: outcome.message,
    providerStillHealthy: outcome.providerStillHealthy,
  };
}
