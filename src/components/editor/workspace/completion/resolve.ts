import type { LspCompletionItem, LspCompletionResolveResult } from "../../../../lib/editor/lsp";
import {
  type ClassifyCompletionResolveInput,
  type CompletionResolveOutcome,
  type ExecuteCompletionResolveOptions,
  type CompletionRequestIdentity,
  type CompletionResolveState,
  type CompletionAcceptancePlanV2,
} from "./types";
export const RESOLVE_ADDITIONAL_EDIT_TIMEOUT_MS = 3000;
import { parseLspSnippet } from "./snippets";


/**
 * Pure classification of completion resolve outcomes (§ED-COMP-001).
 * Enforces rule: "resolver 缺失不推导 not-required".
 */
export function classifyCompletionResolveOutcome(
  input: ClassifyCompletionResolveInput,
): CompletionResolveOutcome {
  const { item } = input;
  if (input.cancelled) {
    return { kind: "cancelled", reason: "operation-cancelled", item };
  }
  if (input.isStale) {
    return {
      kind: "stale",
      expectedRevision: input.tokenRevision ?? 0,
      currentRevision: input.currentRevision ?? -1,
      item,
    };
  }
  if (input.timedOut) {
    return { kind: "timeout", durationMs: RESOLVE_ADDITIONAL_EDIT_TIMEOUT_MS, item };
  }
  if (input.error !== undefined && input.error !== null) {
    const errorMsg = input.error instanceof Error ? input.error.message : String(input.error);
    return { kind: "failed", error: errorMsg, item };
  }
  if (input.resolvedItem) {
    return {
      kind: "resolved",
      item: input.resolvedItem,
      edits: input.resolvedItem.additionalTextEdits ?? [],
    };
  }
  if (item.additionalTextEdits && item.additionalTextEdits.length > 0) {
    return { kind: "not-required", item };
  }
  if (!input.hasResolver) {
    // ED-COMP-001: resolver 缺失不推导 not-required
    return { kind: "unavailable", reason: "missing-resolver", item };
  }
  return { kind: "unavailable", reason: "resolver-returned-null", item };
}


/**
 * Executes an LSP item resolve with full typed outcome classification (§ED-COMP-001).
 */
export async function executeCompletionResolve(
  options: ExecuteCompletionResolveOptions,
): Promise<CompletionResolveOutcome> {
  const {
    item,
    resolve,
    token,
    isStillCurrent,
    timeoutMs = RESOLVE_ADDITIONAL_EDIT_TIMEOUT_MS,
    getDocumentRevision,
    signal,
  } = options;

  if (signal?.aborted) {
    return classifyCompletionResolveOutcome({ item, hasResolver: !!resolve, cancelled: true });
  }
  if (!isStillCurrent(token)) {
    return classifyCompletionResolveOutcome({
      item,
      hasResolver: !!resolve,
      isStale: true,
      tokenRevision: token.documentRevision,
      currentRevision: getDocumentRevision?.(),
    });
  }
  if (item.additionalTextEdits && item.additionalTextEdits.length > 0 && !resolve) {
    return classifyCompletionResolveOutcome({ item, hasResolver: false });
  }
  if (!resolve) {
    return classifyCompletionResolveOutcome({ item, hasResolver: false });
  }

  const startRevision = getDocumentRevision?.() ?? token.documentRevision;
  let timeoutId: number | null = null;
  const timeoutPromise = new Promise<{ timeout: true; }>((res) => {
    timeoutId = window.setTimeout(() => res({ timeout: true }), timeoutMs);
  });

  let abortListener: (() => void) | null = null;
  const abortPromise = signal
    ? new Promise<{ aborted: true; }>((res) => {
      abortListener = () => res({ aborted: true });
      signal.addEventListener("abort", abortListener, { once: true });
    })
    : null;

  try {
    const rawToResolve = item.raw ?? item;
    const raceCompetitors: Promise<unknown>[] = [
      resolve(rawToResolve),
      timeoutPromise,
    ];
    if (abortPromise) raceCompetitors.push(abortPromise);

    const raceResult = await Promise.race(raceCompetitors);
    if (timeoutId !== null) window.clearTimeout(timeoutId);

    if (signal?.aborted || (typeof raceResult === "object" && raceResult !== null && "aborted" in raceResult)) {
      return classifyCompletionResolveOutcome({ item, hasResolver: true, cancelled: true });
    }
    if (typeof raceResult === "object" && raceResult !== null && "timeout" in raceResult) {
      return classifyCompletionResolveOutcome({ item, hasResolver: true, timedOut: true });
    }

    if (!isStillCurrent(token)) {
      return classifyCompletionResolveOutcome({
        item,
        hasResolver: true,
        isStale: true,
        tokenRevision: token.documentRevision,
        currentRevision: getDocumentRevision?.(),
      });
    }
    if (getDocumentRevision && getDocumentRevision() !== startRevision) {
      return classifyCompletionResolveOutcome({
        item,
        hasResolver: true,
        isStale: true,
        tokenRevision: startRevision,
        currentRevision: getDocumentRevision(),
      });
    }

    const response = raceResult as LspCompletionResolveResult | LspCompletionItem | null;
    if (response && typeof response.kind === "string") {
      if (response.kind === "unavailable") return { kind: "unavailable", reason: response.reason, item };
      if (response.kind === "timeout") return classifyCompletionResolveOutcome({ item, hasResolver: true, timedOut: true });
      if (response.kind === "failed") return { kind: "failed", error: response.message, item };
    }
    const resolved = response && typeof response.kind === "string" ? response.item : response;
    if (!resolved) {
      return classifyCompletionResolveOutcome({ item, hasResolver: true, resolvedItem: null });
    }

    const mergedItem: LspCompletionItem = {
      ...item,
      ...resolved,
      additionalTextEdits: resolved.additionalTextEdits ?? item.additionalTextEdits,
    };

    return classifyCompletionResolveOutcome({
      item,
      hasResolver: true,
      resolvedItem: mergedItem,
    });
  } catch (err) {
    if (!isStillCurrent(token)) {
      return classifyCompletionResolveOutcome({
        item,
        hasResolver: true,
        isStale: true,
        tokenRevision: token.documentRevision,
        currentRevision: getDocumentRevision?.(),
      });
    }
    return classifyCompletionResolveOutcome({ item, hasResolver: true, error: err });
  } finally {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
}


/** Stable-enough identity for QA surfaces; providers rarely send item ids. */
export function completionItemId(item: LspCompletionItem): string {
  return [item.label, item.kind ?? "", item.sortText ?? ""].join("#");
}


/**
 * Pure acceptance classifier (§8.19.4): given the item and its resolve state,
 * decide whether the merged acceptance may commit, must wait for an explicit
 * "insert without import" choice, or is blocked outright.
 */
export function buildCompletionAcceptancePlanV2(input: {
  identity: CompletionRequestIdentity;
  item: LspCompletionItem;
  resolveState: CompletionResolveState;
  /** Set when the range planner rejected provider edits as overlapping/illegal. */
  overlapRejected?: boolean;
}): CompletionAcceptancePlanV2 {
  const rawInsert = input.item.textEdit
    ? input.item.textEdit.newText
    : (input.item.insertText ?? input.item.label);
  const snippet = input.item.insertTextFormat === 2 ? parseLspSnippet(rawInsert).placeholders : null;
  const additional = input.item.additionalTextEdits ?? [];
  const disposition: CompletionAcceptancePlanV2["disposition"] = input.overlapRejected
    ? "blocked-overlap"
    : input.resolveState.kind === "stale" || input.resolveState.kind === "cancelled"
      ? "blocked-stale"
      : input.resolveState.kind === "timed-out" || input.resolveState.kind === "failed" || input.resolveState.kind === "unavailable"
        ? "needs-explicit-primary-only"
        : "ready";
  return {
    identity: input.identity,
    itemId: completionItemId(input.item),
    primary: input.item.textEdit ?? {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
      newText: rawInsert,
    },
    additional,
    snippet,
    resolve: input.resolveState,
    disposition,
  };
}
