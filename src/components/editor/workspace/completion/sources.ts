import { completeAnyWord, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import type { LspCompletionItem, LspCompletionResolveResult, LspCompletionResult } from "../../../../lib/editor/lsp";
import { lspPositionFromOffset, offsetFromLspPosition } from "../lspPositions";
import { isInsideStringOrComment } from "../syntaxContext";
import {
  type LspCompletionHooks,
  type CompletionRequestToken,
  type CompletionInvocationReason,
  type CompletionInvocationRequest,
  type CompletionCandidatePair,
  type CompletionItemResolver,
  type CompletionCandidateIdentity,
  type FixtureCompletionHooks,
  type CompletionRequestIdentity,
} from "./types";
import { sameCompletionIdentity } from "./capabilities";
import { completionRequestStartedAt, recordCompletionTelemetry } from "./telemetry";
import { recordBasicCompletionInvocation, recordCompletionInvocationEvidence, providerScopeFor } from "./invocation";
import {
  MAX_COMPLETION_OPTIONS,
  symbolIdentityFromItem,
  matchesSymbolPattern,
  matchesCaseRule,
  boostFromTypedPrefix,
  completionKindToType,
  matchCompletionQuery,
  compareCandidatePairs,
} from "./ranking";
import { completionInfo } from "./information";
import { applyLspCompletion, commitLspCompletion } from "./acceptance";
import { completionAcceptIntent } from "./acceptIntent";
import { parseLspSnippet } from "./snippets";


let completionRequestIdCounter = 0;

export function createLspCompletionSource(hooks: LspCompletionHooks): CompletionSource {
  const isStillCurrent = (token: CompletionRequestToken): boolean => {
    const identity = hooks.identity();
    if (!identity) return false;
    if (!sameCompletionIdentity(identity, token)) return false;
    const revision = hooks.getDocumentRevision?.();
    if (revision !== undefined && revision !== token.documentRevision) return false;
    return true;
  };

  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    // Include `$` and `@` so Java/Kotlin/JS identifiers and decorators continue
    // the same completion session instead of closing after one character.
    const word = context.matchBefore(/[\w$@]+/);
    const charBefore = context.pos > 0
      ? context.state.sliceDoc(context.pos - 1, context.pos)
      : "";
    const triggers = hooks.triggerCharacters();
    const preWordChar = word && word.from > 0
      ? context.state.sliceDoc(word.from - 1, word.from)
      : "";
    // Trigger-only: just typed `.` / `:` with no identifier yet.
    const triggerOnly = !word && !!charBefore && triggers.includes(charBefore);
    // Also treat typing right after a trigger (e.g. `obj.t`) as a triggered
    // completion so the server gets triggerKind=2 for member lists. Whitespace
    // never counts as the trigger: jdtls registers ` ` in its trigger set but
    // answers a space-triggered word request with an empty list, and a space
    // before an identifier did not trigger the request anyway.
    const afterTrigger = !!word
      && word.from > 0
      && preWordChar.trim().length > 0
      && triggers.includes(preWordChar);
    const triggerOriginChar = hooks.consumeTriggerOrigin?.(context.pos, context.state.doc.length) ?? null;
    const isTriggerOrigin = triggerOriginChar !== null;
    const effectiveExplicit = context.explicit && !isTriggerOrigin;

    if (!effectiveExplicit && !word && !triggerOnly && !isTriggerOrigin) return null;
    // Suppress word-based LSP autocompletion inside string literals or comments
    // unless user explicitly invoked completion (Ctrl+Space) or typed a trigger character.
    if (!effectiveExplicit && !triggerOnly && !afterTrigger && !isTriggerOrigin && isInsideStringOrComment(context.state, context.pos)) {
      return null;
    }

    // Identity is captured at request start; a request without provable
    // identity is typed unavailable and falls back to buffer words — except at
    // a member access, where words would pose as members (DEC-ALIGN-09).
    const memberAccess = charBefore === "." || preWordChar === ".";
    const unavailableFallback = () => {
      if (!memberAccess) return completeAnyWord(context);
      hooks.onProviderUnavailable?.({ explicit: context.explicit });
      return null;
    };
    const identityAtStart = hooks.identity();
    if (!identityAtStart) return unavailableFallback();
    completionRequestIdCounter += 1;
    const token: CompletionRequestToken = {
      ...identityAtStart,
      requestId: `completion-${completionRequestIdCounter}`,
    };
    completionRequestStartedAt.set(token, performance.now());
    const policyRevisionAtStart = hooks.controller?.getRevision?.() ?? 1;
    recordCompletionTelemetry(token, "fetching");

    // LSP responses are tied to a document version. Do not spend renderer time
    // mapping a response that became stale while the user kept typing.
    context.addEventListener("abort", () => { }, { onDocChange: true });

    const effectiveTrigger = isTriggerOrigin || triggerOnly || afterTrigger;
    const reason: CompletionInvocationReason = effectiveExplicit
      ? "explicit"
      : effectiveTrigger
        ? "trigger"
        : "typing";

    // Check auto-trigger preference
    if (!effectiveExplicit && hooks.controller) {
      const typedLen = word ? word.text.length : 0;
      if (!hooks.controller.shouldAutoTrigger(typedLen, false, reason)) {
        return null;
      }
    }

    // For plain non-trigger typing (e.g. typing identifiers in Java without `.` or `:`),
    // settle briefly so rapid typing does not spam heavy LSP queries on every keystroke.
    if (!effectiveExplicit && !effectiveTrigger) {
      const delayMs = hooks.controller?.getTriggerDelayMs() ?? 120;
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, delayMs);
        context.addEventListener("abort", () => {
          window.clearTimeout(timer);
          resolve();
        });
      });
      if (context.aborted) return null;
      if ((hooks.controller?.getRevision?.() ?? 1) !== policyRevisionAtStart) {
        recordCompletionTelemetry(token, "stale", { reason: "policy-changed-before-fetch" });
        return completeAnyWord(context);
      }
    }

    // LSP trigger semantics: an explicit invocation (Ctrl+Space) is always
    // `Invoked` (triggerKind 1). Claiming a trigger character describes a
    // different activation cause — and jdtls answers a space-triggered
    // request with an empty list, which silenced every completion at a
    // space-prefixed identifier. Typing keeps triggerKind 2 only for a real
    // member-access trigger (`obj.t`); plain identifier typing stays Invoked.
    const triggerCharacter = !effectiveExplicit && (isTriggerOrigin || triggerOnly)
      ? (triggerOriginChar ?? charBefore)
      : !effectiveExplicit && afterTrigger
        ? preWordChar
        : null;
    const position = lspPositionFromOffset(context.state.doc, context.pos);
    const invocationOrdinal = recordBasicCompletionInvocation({
      workspaceId: token.workspaceId,
      fileKey: token.fileKey,
      documentRevision: token.documentRevision,
      positionKey: `${position.line}:${position.character}`,
      reason,
      providerGeneration: token.lspSessionGeneration,
    });
    const requestedScope: CompletionInvocationRequest["requestedScope"] =
      invocationOrdinal >= 2 ? "expanded" : "default";
    // ED-COMP-004: an explicit invocation that falls back for missing scope
    // facts names its prerequisite once via the hook; typing/trigger popups
    // stay silent. Fires before fetch so the reason is visible even when the
    // provider itself is unavailable.
    if (reason === "explicit" && token.projectScope?.status === "scope-facts-missing") {
      hooks.onScopeFallback?.(token.projectScope, reason);
    }
    let result: LspCompletionResult | null = null;
    try {
      result = await hooks.fetch(
        position,
        triggerCharacter,
        token,
        { invocationOrdinal, requestedScope },
      );
    } catch {
      result = null;
    }
    if (context.aborted) return null;
    if ((hooks.controller?.getRevision?.() ?? 1) !== policyRevisionAtStart) {
      recordCompletionTelemetry(token, "stale", { reason: "policy-changed-after-fetch" });
      return completeAnyWord(context);
    }
    // Validate the request identity again after the await: file switch,
    // document revision change or session restart invalidates the response.
    if (!isStillCurrent(token)) {
      recordCompletionTelemetry(token, "stale", { reason: "identity-changed-after-fetch" });
      return completeAnyWord(context);
    }
    if (result === null) {
      recordCompletionTelemetry(token, "failed", { reason: "fetch-failed" });
      return unavailableFallback();
    }
    // Inactive/unavailable provider is unavailable regardless of item count:
    // stale non-empty items from a stopped/restarted session must never enter
    // the popup (§8.16.2 containment).
    if (!result.status.active) {
      recordCompletionTelemetry(token, "unavailable", { reason: "provider-inactive" });
      return unavailableFallback();
    }

    recordCompletionInvocationEvidence({
      requestId: token.requestId,
      workspaceId: token.workspaceId,
      fileKey: token.fileKey,
      languageId: token.languageId,
      documentRevision: token.documentRevision,
      providerGeneration: token.lspSessionGeneration,
      reason,
      invocationOrdinal,
      requestedScope,
      providerScope: providerScopeFor(
        requestedScope,
        hooks.advertisesScopeExpansion?.() ?? false,
      ),
      projectScope: token.projectScope ?? null,
      itemCount: result.items.length,
      isIncomplete: result.isIncomplete === true,
      at: Date.now(),
    });

    if (result.items.length === 0) {
      recordCompletionTelemetry(token, "popup", { itemCount: 0 });
      return null;
    }

    if (result.truncated) {
      hooks.reportDiagnostic?.("truncated", `${result.items.length}+`);
    }

    const typed = word ? word.text : "";
    const query = word ? context.state.doc.sliceString(word.from, context.pos) : "";
    const rawItems = result.items;
    const pairs: CompletionCandidatePair[] = [];
    const policyRev = policyRevisionAtStart;

    // The server response is already relevance ordered. Mapping more entries
    // than the popup can consume only allocates closures/documentation helpers
    // on the renderer thread, which is especially visible for jdtls lists.
    const policy = hooks.controller?.getPolicy?.() ?? {
      autoPopup: true,
      delayMs: 50,
      caseMatching: "none" as const,
      sortMode: "provider-relevance" as const,
      autoInsertSingle: false,
      excludedSymbols: [],
      prioritizedSymbols: [],
      maxVisibleItems: MAX_COMPLETION_OPTIONS,
      documentation: { enabled: true, delayMs: 250 },
    };
    const isCandidateStillCurrent = (candidateToken: CompletionRequestToken): boolean => (
      isStillCurrent(candidateToken)
      && (hooks.controller?.getRevision?.() ?? 1) === policyRev
    );
    const maxItemsLimit = policy.maxVisibleItems ?? MAX_COMPLETION_OPTIONS;
    const maxItemsToProcess = Math.min(rawItems.length, maxItemsLimit);
    for (let i = 0;i < maxItemsToProcess;i += 1) {
      const item = rawItems[i];
      if (!item) continue;

      const identity = symbolIdentityFromItem(item);
      // §8.21.3 V2-E: Excluded symbols matching on provider item FQN/detail/data
      if (matchesSymbolPattern(identity, policy.excludedSymbols)) {
        continue;
      }

      const filterText = item.filterText?.trim() ? item.filterText : null;
      const label = filterText ?? item.label;

      // §8.21.3 V2-E: Case matching filter
      if (typed && !matchesCaseRule(typed, label, policy.caseMatching)) {
        continue;
      }

      // §8.21.3 V2-E: Prioritized symbols boost and provenance
      const isPrioritized = matchesSymbolPattern(identity, policy.prioritizedSymbols);
      let boost = boostFromTypedPrefix(typed, label, item.sortText);
      if (isPrioritized) {
        boost = (boost ?? 0) + 500;
      }

      const qualifiedTypeSuffix = item.kind === 7 && filterText && item.detail?.endsWith(`.${filterText}`)
        ? item.detail.slice(0, -filterText.length - 1)
        : null;
      const isDuplicatedJavaTypeLabel = qualifiedTypeSuffix !== null
        && item.label === `${filterText} - ${qualifiedTypeSuffix}`;
      const javaMethodSeparator = token.languageId === "java"
        && item.kind === 2
        && item.detail?.endsWith(item.label)
        ? item.label.lastIndexOf(" : ")
        : -1;
      const displayLabel = javaMethodSeparator > 0
        ? item.label.slice(0, javaMethodSeparator)
        : isDuplicatedJavaTypeLabel
          ? undefined
          : filterText && filterText !== item.label ? item.label : undefined;
      const presentationDetail = javaMethodSeparator > 0
        ? item.label.slice(javaMethodSeparator + 3)
        : isDuplicatedJavaTypeLabel ? qualifiedTypeSuffix : item.detail;
      const truncatedDetail = result.truncated && i === 0
        ? `${presentationDetail ?? ""}${presentationDetail ? " · " : ""}list truncated — keep typing to refine`.trim()
        : isPrioritized
          ? `${presentationDetail ?? ""}${presentationDetail ? " · " : ""}(prioritized)`.trim()
          : presentationDetail ?? undefined;
      let resolvedItemPromise: Promise<LspCompletionResolveResult | LspCompletionItem | null> | null = null;
      const resolveItem: CompletionItemResolver | undefined = hooks.resolve
        ? () => {
          if (!resolvedItemPromise) {
            resolvedItemPromise = hooks.resolve!(item.raw, token);
          }
          return resolvedItemPromise;
        }
        : undefined;
      // Acceptance/retry resolver: reuses a successful memoized resolve but
      // gives a failed or empty one a real fresh round-trip (§8.19.4 Retry).
      const resolveFresh: CompletionItemResolver | undefined = hooks.resolve
        ? () => {
          if (!resolvedItemPromise) return hooks.resolve!(item.raw, token);
          return resolvedItemPromise.then((response) => {
            const resolved = response && typeof response.kind === "string"
              ? response.kind === "resolved" ? response.item : null
              : response;
            return resolved ? response : hooks.resolve!(item.raw, token);
          });
        }
        : undefined;
      const showDoc = policy.documentation.enabled;
      const completion: Completion & { isLspProvider: true; } = {
        label,
        displayLabel,
        sortText: item.sortText ?? undefined,
        boost,
        type: completionKindToType(item.kind),
        rawKind: item.kind,
        isLspProvider: true,
        isTemplateSnippet: item.kind === 15 || item.insertTextFormat === 2,
        detail: truncatedDetail,
        info: showDoc && (item.documentation || resolveItem)
          ? () => completionInfo(item, resolveItem, token, isStillCurrent)
          : undefined,
        apply: (view, _completion, from, to) =>
          applyLspCompletion(
            view,
            item,
            from,
            to,
            resolveFresh,
            token,
            isCandidateStillCurrent,
            hooks.getDocumentRevision,
            hooks.reportDiagnostic,
            hooks.onResolveGate,
            policy.excludedSymbols,
            completionAcceptIntent.get(view) ?? "insert",
            hooks.onAcceptancePending,
            hooks.onAcceptanceSettled,
          ),
      };

      const match = matchCompletionQuery(label, query);
      const candidateId = `${token.workspaceId}:${token.fileKey}:cand-${i}:${item.label}`;
      const candidateIdentity: CompletionCandidateIdentity = {
        candidateId,
        rawResponseIndex: i,
        workspaceId: token.workspaceId,
        fileKey: token.fileKey,
        documentRevision: token.documentRevision,
        lspSessionGeneration: token.lspSessionGeneration,
        policyRevision: policyRev,
      };

      pairs.push({
        identity: candidateIdentity,
        rawItem: item,
        completion,
        matchTier: match.tier,
        matchScore: isPrioritized ? match.score + 500 : match.score,
      });
    }
    if (context.aborted) return null;

    // §ED-COMP-002: Sort atomic candidate pairs — never splits raw and mapped pairs
    pairs.sort((a, b) => compareCandidatePairs(a, b, policy.sortMode));

    const mapped = pairs.map((p) => p.completion);
    const mappedItems = pairs.map((p) => p.rawItem);

    // Prefer textEdit start when every item shares the same replace range so
    // CM's client-side filtering aligns with the server's replace span.
    let from = word ? word.from : context.pos;
    const firstEdit = mappedItems[0]?.textEdit;
    if (firstEdit && mappedItems.every((item) => (
      item.textEdit
      && item.textEdit.range.start.line === firstEdit.range.start.line
      && item.textEdit.range.start.character === firstEdit.range.start.character
      && item.textEdit.range.end.line === firstEdit.range.end.line
      && item.textEdit.range.end.character === firstEdit.range.end.character
    ))) {
      from = offsetFromLspPosition(context.state.doc, firstEdit.range.start);
    }

    // §8.24.6 Y5: autoInsertSingle executes in single transaction when conditions pass
    if (
      policy.autoInsertSingle
      && mapped.length === 1
      && !result.isIncomplete
      && !result.truncated
      && isCandidateStillCurrent(token)
    ) {
      const targetView = hooks.getView?.();
      if (targetView) {
        const singleItem = mappedItems[0];
        const isSnippet = singleItem.insertTextFormat === 2;
        const rawText = singleItem.insertReplaceEdit?.newText
          ?? singleItem.textEdit?.newText ?? singleItem.insertText ?? singleItem.label;
        const parsedSnippet = isSnippet ? parseLspSnippet(rawText) : null;
        const hasAmbiguousChoices = parsedSnippet && parsedSnippet.placeholders.some((p) => (p.choices?.length ?? 0) > 1);
        if (!hasAmbiguousChoices) {
          let itemToCommit: LspCompletionItem | null = singleItem;
          if (hooks.resolve) {
            try {
              const response = await hooks.resolve(singleItem.raw ?? singleItem, token);
              itemToCommit = response && typeof response.kind === "string"
                ? response.kind === "resolved" ? response.item : null
                : response;
            } catch {
              itemToCommit = null;
            }
          }
          if (itemToCommit) {
            if (!isCandidateStillCurrent(token)) return null;
            hooks.reportDiagnostic?.("auto-inserted-single");
            const applied = commitLspCompletion(
              targetView,
              itemToCommit,
              from,
              context.pos,
              token,
              isCandidateStillCurrent,
              hooks.reportDiagnostic,
              policy.excludedSymbols,
            );
            if (applied) {
              return null;
            }
          }
        }
      }
    }

    // Keep server order for the head of the list, then cap for popup cost.
    recordCompletionTelemetry(token, "popup", {
      itemCount: mapped.length,
      truncated: result.truncated ?? false,
    });
    return {
      from,
      options: mapped,
      // Every LSP item (including resolve data and edit ranges) belongs to
      // token.documentRevision. Re-query after typing even for complete lists;
      // reusing them via validFor leaves visible options that cannot be accepted.
      filter: true,
    };
  };
}


/**
 * Fixture-only source (unit tests, perf benches). Wraps the legacy
 * no-identity hooks with a synthetic identity so mapping logic can be
 * exercised without a production host. Production code must never import
 * this helper.
 */
export function createFixtureCompletionSource(hooks: FixtureCompletionHooks): CompletionSource {
  const identity: CompletionRequestIdentity = {
    workspaceId: "fixture-workspace",
    fileKey: "fixture-file",
    filePath: "/fixture/file.ts",
    uri: "file:///fixture/file.ts",
    languageId: "fixture",
    documentRevision: 0,
    lspSessionGeneration: 0,
    ...(hooks.projectScope !== undefined ? { projectScope: hooks.projectScope } : {}),
  };
  return createLspCompletionSource({
    identity: () => ({
      ...identity,
      documentRevision: hooks.getDocumentRevision?.() ?? identity.documentRevision,
    }),
    fetch: (position, triggerCharacter) => hooks.fetch(position, triggerCharacter),
    resolve: hooks.resolve
      ? (raw) => hooks.resolve!(raw)
      : undefined,
    triggerCharacters: () => hooks.triggerCharacters?.() ?? [],
    getDocumentRevision: hooks.getDocumentRevision ?? (() => identity.documentRevision),
    reportDiagnostic: hooks.reportDiagnostic ?? (() => { }),
    onScopeFallback: hooks.onScopeFallback,
    onProviderUnavailable: hooks.onProviderUnavailable,
  });
}
