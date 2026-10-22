import type { LspCompletionResult } from "../../../../lib/editor/lsp";
import { sameCompletionScopeFacts } from "../completionScopeAdapter";
import { type CompletionRequestIdentity, type CompletionProviderResult } from "./types";
import { MAX_COMPLETION_OPTIONS } from "./ranking";


/**
 * Classify one raw provider round-trip into the typed envelope. UI must read
 * `kind`/`truncated` from here instead of inferring from empty arrays.
 */
export function toCompletionProviderResult(input: {
  identity: CompletionRequestIdentity;
  result: LspCompletionResult | null;
  statusActive: boolean;
  capabilityAdvertised: boolean;
}): CompletionProviderResult {
  const { identity, result } = input;
  if (!input.capabilityAdvertised) {
    return {
      kind: "unavailable",
      identity,
      reason: "capability-not-advertised",
    };
  }
  if (!input.statusActive) {
    return { kind: "unavailable", identity, reason: "no-provider" };
  }
  if (!result) {
    // A dropped/null response for an unchanged identity is cancellation-like:
    // never reported as "no candidates".
    return { kind: "stale", identity };
  }
  const items = result.items ?? [];
  return {
    kind: "available",
    identity,
    items: [...items],
    isIncomplete: result.isIncomplete === true,
    truncated: items.length >= MAX_COMPLETION_OPTIONS,
    evidence: {
      source: "lsp",
      providerId: result.status?.selectedCommandId ?? null,
      providerVersion: result.status?.displayName ?? null,
      workspaceId: identity.workspaceId,
      fileKey: identity.fileKey,
      documentRevision: identity.documentRevision,
      providerGeneration: identity.lspSessionGeneration,
      scope: "file",
      completeness: result.isIncomplete ? "available-partial" : "available-complete",
    },
  };
}


export function sameCompletionIdentity(
  a: CompletionRequestIdentity,
  b: CompletionRequestIdentity,
): boolean {
  return a.workspaceId === b.workspaceId
    && a.fileKey === b.fileKey
    && a.filePath === b.filePath
    && a.uri === b.uri
    && a.languageId === b.languageId
    && a.documentRevision === b.documentRevision
    && a.lspSessionGeneration === b.lspSessionGeneration
    && sameCompletionScopeFacts(a.projectScope, b.projectScope);
}
