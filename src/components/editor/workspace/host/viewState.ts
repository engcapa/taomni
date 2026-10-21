import { importFoldRange } from "../importFold";
import { EditorSelection, type Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { foldEffect, foldedRanges } from "@codemirror/language";
import { MAX_VIEW_STATE_FOLDS, MAX_VIEW_STATE_SELECTIONS, type PersistedEditorViewState, type PersistedViewSelection } from "../workspaceLayoutPersistence";


// ED-MAIN-009: hashing a multi-megabyte document costs ~100ms, so capture
// ED-REPAIR-009: exact document content hash cached by immutable Text instance.
// Never reused across document mutations by wall-clock heuristics.
export const textIdentityCache = new WeakMap<Text, string>();


export function hashDocumentText(doc: Text): string {
  let hash = 0x811c9dc5;
  // The iterator yields line-break chunks ("\n") as values of their own, so
  // hashing every chunk's characters reproduces the string hash exactly.
  for (const iter = doc.iter(); !iter.next().done;) {
    const chunk = iter.value;
    for (let index = 0; index < chunk.length; index += 1) {
      hash ^= chunk.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return `${doc.length}:${(hash >>> 0).toString(16)}`;
}


/**
 * Exact content identity for a CodeMirror document, cached on the immutable Text instance.
 * ED-REPAIR-009: Text identity is strictly bound to the immutable Text instance,
 * never reused across document mutations by wall-clock heuristics.
 */
export function documentTextIdentity(doc: Text): string {
  const cached = textIdentityCache.get(doc);
  if (cached !== undefined) return cached;
  const identity = hashDocumentText(doc);
  textIdentityCache.set(doc, identity);
  return identity;
}


/**
 * ED-IMPROVE-007: capture this view's caret/selection, scroll and fold state.
 * Pure over the CodeMirror view so the workspace can store it in memory and
 * persist it with the layout without serializing per keystroke. ED-MAIN-009
 * adds the content identity and the horizontal scroll offset.
 * ED-REPAIR-009: binds the capture identity to the exact doc version.
 */
/** Views whose file has a default import fold, keyed to that file's path. */
export const importFoldPathByView = new WeakMap<EditorView, string>();


export function importsExpandedIn(view: EditorView): boolean {
  const path = importFoldPathByView.get(view);
  const range = path ? importFoldRange(path, view.state.doc.toString()) : null;
  if (!range) return false;
  let folded = false;
  foldedRanges(view.state).between(range.from, range.from + 1, (from) => {
    if (from === range.from) folded = true;
  });
  return !folded;
}


export function captureEditorViewState(view: EditorView): PersistedEditorViewState {
  const selection = view.state.selection;
  const main = selection.main;
  const selections: PersistedViewSelection[] = [];
  for (const range of selection.ranges) {
    if (range === main) continue;
    if (selections.length >= MAX_VIEW_STATE_SELECTIONS - 1) break;
    selections.push({ anchor: range.anchor, head: range.head });
  }
  const folds: PersistedEditorViewState["folds"] = [];
  const folded = foldedRanges(view.state);
  for (const iter = folded.iter(); iter.value && folds.length < MAX_VIEW_STATE_FOLDS; iter.next()) {
    if (iter.to <= iter.from) continue;
    folds.push({ from: iter.from, to: iter.to });
  }
  return {
    mainSelection: { anchor: main.anchor, head: main.head },
    selections,
    scrollTop: view.scrollDOM?.scrollTop ?? 0,
    folds,
    textIdentity: documentTextIdentity(view.state.doc),
    scrollLeft: view.scrollDOM?.scrollLeft ?? 0,
    ...(importsExpandedIn(view) ? { importsExpanded: true } : {}),
  };
}


export interface ApplyPersistedEditorViewStateResult {
  applied: boolean;
  deferredScroll: { scrollTop: number; scrollLeft: number } | null;
}


/**
 * ED-IMPROVE-007: apply a persisted snapshot once when the view mounts.
 * Offsets beyond the live document are clamped and folds outside it are
 * dropped, so a stale or corrupt snapshot can never throw or select garbage.
 * ED-REPAIR-009: returns deferred scroll targets if geometry is unready on mount.
 */
export function applyPersistedEditorViewState(
  view: EditorView,
  state: PersistedEditorViewState,
): ApplyPersistedEditorViewStateResult {
  // ED-MAIN-009: a snapshot that carries a content identity only restores its
  // selection/folds/scroll when the live text still matches. Legacy snapshots
  // without an identity keep the original clamp behavior.
  if (
    state.textIdentity !== undefined
    && state.textIdentity !== documentTextIdentity(view.state.doc)
  ) {
    return { applied: false, deferredScroll: null };
  }
  const docLength = view.state.doc.length;
  const clamp = (value: number): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(docLength, Math.floor(value)));
  };
  const toRange = (range: PersistedViewSelection) => EditorSelection.range(
    clamp(range.anchor),
    clamp(range.head),
  );
  const ranges = [
    toRange(state.mainSelection),
    ...state.selections.slice(0, MAX_VIEW_STATE_SELECTIONS - 1).map(toRange),
  ];
  view.dispatch({
    selection: EditorSelection.create(ranges, 0),
    scrollIntoView: false,
  });
  for (const fold of state.folds) {
    const from = clamp(fold.from);
    const to = clamp(fold.to);
    if (to <= from || to > docLength) continue;
    view.dispatch({ effects: foldEffect.of({ from, to }) });
  }
  let deferredScroll: { scrollTop: number; scrollLeft: number } | null = null;
  if (view.scrollDOM && (state.scrollTop > 0 || (state.scrollLeft ?? 0) > 0)) {
    const dom = view.scrollDOM;
    const targetScrollTop = state.scrollTop > 0 ? state.scrollTop : 0;
    const targetScrollLeft = (state.scrollLeft ?? 0) > 0 ? (state.scrollLeft ?? 0) : 0;
    const canScrollVertically = targetScrollTop > 0 && dom.scrollHeight > dom.clientHeight;
    const canScrollHorizontally = targetScrollLeft > 0 && dom.scrollWidth > dom.clientWidth;
    if (
      (targetScrollTop > 0 && !canScrollVertically)
      || (targetScrollLeft > 0 && !canScrollHorizontally)
    ) {
      deferredScroll = {
        scrollTop: canScrollVertically ? 0 : targetScrollTop,
        scrollLeft: canScrollHorizontally ? 0 : targetScrollLeft,
      };
    }
    if (targetScrollTop > 0 && canScrollVertically) {
      const maxScrollTop = Math.max(0, dom.scrollHeight - dom.clientHeight);
      dom.scrollTop = Math.min(targetScrollTop, maxScrollTop);
    }
    if (targetScrollLeft > 0 && canScrollHorizontally) {
      const maxScrollLeft = Math.max(0, dom.scrollWidth - dom.clientWidth);
      dom.scrollLeft = Math.min(targetScrollLeft, maxScrollLeft);
    }
  }
  return { applied: true, deferredScroll };
}
