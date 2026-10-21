import type { Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { LspCompletionItem, LspPosition, LspTextEdit } from "../../../../lib/editor/lsp";
import { isInsideStringOrComment } from "../syntaxContext";
import { type SymbolPatternRule } from "../intelligencePreferences";
import {
  type PlannedChange,
  type PlanningChanges,
  type CompletionRequestToken,
  type CompletionAcceptanceDiagnostic,
  type CompletionAcceptIntent,
  type CompletionItemResolver,
  type CompletionResolveGateRequest,
  type CompletionResolveOutcome,
  type CompletionResolveGateReason,
} from "./types";
import { recordCompletionTelemetry } from "./telemetry";
import { symbolIdentityFromItem, matchesSymbolPattern } from "./ranking";
import { parseLspSnippet, lspSnippetSessions } from "./snippets";
import { RESOLVE_ADDITIONAL_EDIT_TIMEOUT_MS, executeCompletionResolve } from "./resolve";


export function strictOffsetFromLspPosition(doc: Text, position: LspPosition): number | null {
  if (
    !Number.isInteger(position.line)
    || !Number.isInteger(position.character)
    || position.line < 0
    || position.character < 0
    || position.line >= doc.lines
  ) {
    return null;
  }
  const line = doc.line(position.line + 1);
  if (position.character > line.length) return null;
  return line.from + position.character;
}


/**
 * Post-image offset of a point inside the primary insert, shifted by any
 * additional edits (e.g. an import) that landed before the primary span.
 * `offsetWithinInsert` may equal `insert.length` for the cursor-at-end case.
 */
export function postImageAnchor(
  changes: PlannedChange[],
  primary: PlannedChange,
  offsetWithinInsert: number,
): number {
  let delta = 0;
  for (const change of changes) {
    if (change === primary) continue;
    if (change.to <= primary.from) {
      delta += change.insert.length - (change.to - change.from);
    }
  }
  return primary.from + offsetWithinInsert + delta;
}


/**
 * Validate additional edits against the primary span: ranges must be inside
 * the document, well-ordered and non-overlapping. Overlapping or illegal
 * ranges never partially apply: the entire completion is rejected and the
 * invalid-additional-edits diagnostic is reported.
 */
export function planCompletionChanges(
  view: EditorView,
  primary: PlannedChange,
  additionalEdits: LspTextEdit[],
): PlanningChanges {
  const list: PlannedChange[] = [primary];
  let ok = true;
  const spans: Array<[number, number]> = [[primary.from, primary.to]];
  for (const edit of additionalEdits) {
    const from = strictOffsetFromLspPosition(view.state.doc, edit.range.start);
    const to = strictOffsetFromLspPosition(view.state.doc, edit.range.end);
    if (from === null || to === null || from > to) {
      ok = false;
      break;
    }
    if (spans.some(([start, end]) => (
      from === to
        ? (start === end ? from === start : from >= start && from <= end)
        : (start === end ? start >= from && start <= to : from < end && to > start)
    ))) {
      ok = false;
      break;
    }
    spans.push([from, to]);
    list.push({ from, to, insert: edit.newText });
  }
  list.sort((a, b) => a.from - b.from || a.to - b.to);
  return { list: ok ? list : [primary], ok };
}


export function commitLspCompletion(
  view: EditorView,
  item: LspCompletionItem,
  from: number,
  to: number,
  token: CompletionRequestToken,
  isStillCurrent: (token: CompletionRequestToken) => boolean,
  reportDiagnostic?: ((kind: CompletionAcceptanceDiagnostic, detail?: string) => void) | undefined,
  excludedSymbols?: readonly SymbolPatternRule[],
  intent: CompletionAcceptIntent = "insert",
): boolean {
  if (view.state.readOnly) {
    return false;
  }
  if (!isStillCurrent(token)) {
    reportDiagnostic?.("identity-mismatch", "accept");
    recordCompletionTelemetry(token, "stale", { reason: "accept" });
    return false;
  }
  if (
    !Number.isInteger(from)
    || !Number.isInteger(to)
    || from < 0
    || to < from
    || to > view.state.doc.length
  ) {
    reportDiagnostic?.("invalid-additional-edits", "primary-range");
    return false;
  }

  // §8.21.3 V2-E: Excluded symbol pattern check on item and additional import edits
  if (excludedSymbols && excludedSymbols.length > 0) {
    const identity = symbolIdentityFromItem(item);
    if (matchesSymbolPattern(identity, excludedSymbols)) {
      reportDiagnostic?.("excluded-symbol-blocked", "item-excluded");
      return false;
    }
    const additionalEdits = item.additionalTextEdits ?? [];
    for (const edit of additionalEdits) {
      for (const pat of excludedSymbols) {
        const cleanPat = pat.pattern.replace(/\*$/, "").trim();
        if (cleanPat && edit.newText.includes(cleanPat)) {
          reportDiagnostic?.("excluded-symbol-blocked", "auto-import-excluded");
          return false;
        }
      }
    }
  }

  const primary = completionPrimaryEdit(view, item, from, to, token, intent);
  if (!primary) {
    reportDiagnostic?.("invalid-additional-edits", "primary-range");
    return false;
  }
  const { replaceFrom, replaceTo, rawInsert } = primary;
  const additionalEdits = item.additionalTextEdits ?? [];
  const isSnippet = item.insertTextFormat === 2;

  const parsed = isSnippet ? parseLspSnippet(rawInsert) : null;
  const insert = parsed ? parsed.text : rawInsert;
  const planned = planCompletionChanges(
    view,
    { from: replaceFrom, to: replaceTo, insert },
    additionalEdits,
  );
  if (!planned.ok) {
    reportDiagnostic?.("invalid-additional-edits");
    return false;
  }

  const primaryChange = planned.list.find((change) => (
    change.insert === insert && change.from === replaceFrom && change.to === replaceTo
  )) ?? planned.list[0];

  // One dispatch carries primary, snippet body and additional edits: one
  // document revision, one Ctrl+Z, no second edit (§8.17.2 step 2/4).
  const placeholderSpans = parsed && parsed.placeholders.length > 0
    ? parsed.placeholders.map((span) => ({
      from: postImageAnchor(planned.list, primaryChange, span.start),
      to: postImageAnchor(planned.list, primaryChange, Math.max(span.end, span.start)),
    }))
    : null;
  const firstSpan = placeholderSpans?.[0];
  const firstPlaceholderStart = parsed?.placeholders[0]?.start;
  const anchor = parsed && parsed.placeholders.length > 0 && firstPlaceholderStart !== undefined
    ? postImageAnchor(planned.list, primaryChange, firstPlaceholderStart)
    : postImageAnchor(planned.list, primaryChange, insert.length);

  view.dispatch({
    changes: planned.list,
    selection: firstSpan
      ? { anchor: firstSpan.from, head: firstSpan.to }
      : { anchor },
    userEvent: "input.complete",
  });
  recordCompletionTelemetry(token, "applied");

  // Registered AFTER the acceptance dispatch so the doc-change invalidator
  // never consumes the acceptance itself; Tab now cycles the spans and any
  // unrelated edit drops the session.
  if (placeholderSpans && placeholderSpans.length > 0) {
    lspSnippetSessions.set(view, {
      spans: placeholderSpans,
      choices: (parsed?.placeholders ?? []).map((placeholder) => placeholder.choices ?? null),
      index: 0,
      docLength: view.state.doc.length,
    });
  }
  return true;
}


export function isJavaIdentifierCharacter(value: string): boolean {
  return /^[\p{ID_Continue}_$]$/u.test(value);
}


export function safeJavaSuffixEnd(
  view: EditorView,
  from: number,
  to: number,
  token: CompletionRequestToken,
): number | null {
  if (token.languageId !== "java" || !view.state.selection.main.empty
    || view.state.selection.main.head !== to || isInsideStringOrComment(view.state, to)) return null;
  const line = view.state.doc.lineAt(to);
  if (from < line.from || from >= to || from > line.to) return null;
  const prefix = view.state.doc.sliceString(from, to);
  if (!/^[\p{ID_Start}_$][\p{ID_Continue}_$]*$/u.test(prefix)) return null;
  if (from > line.from && isJavaIdentifierCharacter(view.state.doc.sliceString(from - 1, from))) return null;
  let end = to;
  while (end < line.to && isJavaIdentifierCharacter(view.state.doc.sliceString(end, end + 1))) end += 1;
  return end;
}


export function completionPrimaryEdit(
  view: EditorView,
  item: LspCompletionItem,
  from: number,
  to: number,
  token: CompletionRequestToken,
  intent: CompletionAcceptIntent,
): { replaceFrom: number; replaceTo: number; rawInsert: string; } | null {
  const doc = view.state.doc;
  const dual = item.insertReplaceEdit;
  if (dual) {
    const insertFrom = strictOffsetFromLspPosition(doc, dual.insert.start);
    const insertTo = strictOffsetFromLspPosition(doc, dual.insert.end);
    const replaceFrom = strictOffsetFromLspPosition(doc, dual.replace.start);
    const replaceTo = strictOffsetFromLspPosition(doc, dual.replace.end);
    if (insertFrom === null || insertTo === null || replaceFrom === null || replaceTo === null
      || insertFrom !== replaceFrom || insertFrom > insertTo || insertTo > replaceTo) return null;
    if (item.textEdit) {
      const oldFrom = strictOffsetFromLspPosition(doc, item.textEdit.range.start);
      const oldTo = strictOffsetFromLspPosition(doc, item.textEdit.range.end);
      if (oldFrom !== insertFrom || oldTo !== insertTo || item.textEdit.newText !== dual.newText) return null;
    }
    return {
      replaceFrom: insertFrom,
      replaceTo: intent === "replace" ? replaceTo : insertTo,
      rawInsert: dual.newText,
    };
  }

  let replaceFrom = from;
  let replaceTo = to;
  if (item.textEdit) {
    const strictFrom = strictOffsetFromLspPosition(doc, item.textEdit.range.start);
    const strictTo = strictOffsetFromLspPosition(doc, item.textEdit.range.end);
    if (strictFrom === null || strictTo === null || strictFrom > strictTo) return null;
    replaceFrom = strictFrom;
    replaceTo = strictTo;
  }
  if (intent === "replace") {
    const suffixEnd = safeJavaSuffixEnd(view, replaceFrom, replaceTo, token);
    if (suffixEnd !== null) replaceTo = suffixEnd;
  }
  return { replaceFrom, replaceTo, rawInsert: item.textEdit?.newText ?? item.insertText ?? item.label };
}

export function applyLspCompletion(
  view: EditorView,
  item: LspCompletionItem,
  from: number,
  to: number,
  resolve: CompletionItemResolver | undefined,
  token: CompletionRequestToken,
  isStillCurrent: (token: CompletionRequestToken) => boolean,
  getDocumentRevision: (() => number) | undefined,
  reportDiagnostic: ((kind: CompletionAcceptanceDiagnostic, detail?: string) => void) | undefined,
  onResolveGate?: ((request: CompletionResolveGateRequest) => void) | undefined,
  excludedSymbols?: readonly SymbolPatternRule[],
  intent: CompletionAcceptIntent = "insert",
  onAcceptancePending?: (cancel: () => void) => void,
  onAcceptanceSettled?: (cancel: () => void) => void,
): void {
  if (view.state.readOnly) {
    return;
  }
  if (item.additionalTextEdits?.length) {
    commitLspCompletion(view, item, from, to, token, isStillCurrent, reportDiagnostic, excludedSymbols, intent);
    return;
  }

  const revisionAtAccept = getDocumentRevision?.();
  const docAtAccept = view.state.doc;
  const controller = new AbortController();
  let retryInFlight = false;

  let settled = false;
  const settle = (): boolean => {
    if (settled) return false;
    settled = true;
    onAcceptanceSettled?.(cancel);
    return true;
  };
  const cancel = (): void => {
    if (settle()) controller.abort();
  };
  onAcceptancePending?.(cancel);

  const runResolve = (resolver: CompletionItemResolver | undefined): Promise<CompletionResolveOutcome> => (
    executeCompletionResolve({
      item,
      resolve: resolver ? () => resolver() : undefined,
      token,
      isStillCurrent,
      timeoutMs: RESOLVE_ADDITIONAL_EDIT_TIMEOUT_MS,
      getDocumentRevision,
      signal: controller.signal,
    })
  );

  // §8.19.4 resolve gate: a timeout/failure keeps the chosen item visible and
  // waits for an explicit Retry or Insert-without-import choice. Nothing is
  // inserted until the user picks; stale/overlap blocks stay hard no-ops.
  const guardCurrent = (): boolean => {
    if (!isStillCurrent(token)) {
      reportDiagnostic?.("identity-mismatch", "resolve-gate");
      return false;
    }
    if (
      view.state.doc !== docAtAccept
      || (getDocumentRevision && revisionAtAccept !== undefined && getDocumentRevision() !== revisionAtAccept)
    ) {
      reportDiagnostic?.("identity-mismatch", "resolve-gate-doc");
      return false;
    }
    return true;
  };
  const insertWithoutImport = (): boolean => {
    if (retryInFlight) return false;
    if (!settle()) return false;
    if (!guardCurrent()) return false;
    return commitLspCompletion(
      view,
      { ...item, additionalTextEdits: [] },
      from,
      to,
      token,
      isStillCurrent,
      reportDiagnostic,
      excludedSymbols,
      intent,
    );
  };
  const retryResolve = async (): Promise<"committed" | "unavailable"> => {
    if (settled || retryInFlight) return "unavailable";
    if (!guardCurrent()) {
      settle();
      return "unavailable";
    }
    retryInFlight = true;
    const outcome = await runResolve(resolve);
    retryInFlight = false;
    if (settled) return "unavailable";
    if (outcome.kind === "stale" || outcome.kind === "cancelled") {
      reportDiagnostic?.("identity-mismatch", `resolve-retry-${outcome.kind}`);
      settle();
      return "unavailable";
    }
    if (outcome.kind !== "resolved" && outcome.kind !== "not-required") return "unavailable";
    if (!guardCurrent()) {
      settle();
      return "unavailable";
    }
    settle();
    const committed = commitLspCompletion(
      view,
      outcome.item,
      from,
      to,
      token,
      isStillCurrent,
      reportDiagnostic,
      excludedSymbols,
      intent,
    );
    return committed ? "committed" : "unavailable";
  };
  const presentGate = (
    reason: CompletionResolveGateReason,
    detail: string,
  ): void => {
    if (settled) return;
    reportDiagnostic?.("additional-edit-unavailable", detail);
    if (!onResolveGate) {
      // No gate surface wired (isolated embedder): blocking beats silently
      // inserting an acceptance that lost its import edits.
      settle();
      return;
    }
    onResolveGate({
      item,
      range: { from, to },
      reason,
      message: reason === "timeout"
        ? "Auto-import unavailable — provider resolve timed out"
        : reason === "unavailable"
          ? "Auto-import unavailable — provider resolve is unavailable"
          : "Auto-import unavailable — provider resolve failed",
      retry: retryResolve,
      insertWithoutImport,
      dismiss: () => {
        cancel();
      },
    });
  };

  void runResolve(resolve)
    .then((outcome) => {
      if (settled) return;
      if (outcome.kind === "stale" || outcome.kind === "cancelled") {
        reportDiagnostic?.("identity-mismatch", `resolve-${outcome.kind}`);
        settle();
        return;
      }
      if (outcome.kind === "timeout") {
        presentGate("timeout", "resolve-timeout");
        return;
      }
      if (outcome.kind === "failed") {
        presentGate("failed", "resolve-failed");
        return;
      }
      if (outcome.kind === "unavailable") {
        presentGate("unavailable", `resolve-${outcome.reason}`);
        return;
      }
      if (outcome.kind !== "resolved" && outcome.kind !== "not-required") return;
      if (!guardCurrent()) {
        settle();
        return;
      }
      settle();
      commitLspCompletion(
        view,
        outcome.item,
        from,
        to,
        token,
        isStillCurrent,
        reportDiagnostic,
        excludedSymbols,
        intent,
      );
    })
    .catch(() => {
      if (settled) return;
      if (!guardCurrent()) {
        settle();
        return;
      }
      presentGate("failed", "resolve-failed");
    });
}
