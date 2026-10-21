import { EditorView } from "@codemirror/view";
import { readNativeTextResult, readTextResult, writeText } from "../../../../lib/clipboard";
import { getAppPlatform, isTauriRuntime } from "../../../../lib/runtime";
import { type GuardedSystemEffect, type GuardedSystemReadResult, type GuardedSystemWriteResult, type WorkspaceClipboardHandle } from "../workspaceClipboardSession";
import { createClipboardCancelledObservation, createClipboardReadObservation, createClipboardWriteObservation, type ClipboardObservationOperation, type ClipboardObservationRecord } from "../clipboardObservationContract";
import { cutEditorSelections, editorClipboardPayload, pasteEditorClipboardPayload, plainTextClipboardPayload, type EditorClipboardPayload } from "../workspaceEditorCommands";


export const editorClipboardPayloadByView = new WeakMap<EditorView, EditorClipboardPayload>();


// Clipboard helpers close over host props through this per-view registry
// (bound at mount) so the module-level helpers stay pure and testable.
export const clipboardContextByView = new WeakMap<
  EditorView,
  ClipboardObservationEndpoint
>();


export interface ClipboardObservationEndpoint {
  workspaceId: string | null;
  onUnavailable: (message: string) => void;
  /** ED-CLIP-004: typed metadata-only observation of the guarded result. */
  onObservation?: (record: ClipboardObservationRecord) => void;
  /** Refcounted session handle (§8.18.4); null for legacy non-workspace views. */
  handle: WorkspaceClipboardHandle | null;
  /** ED-MAIN-007: whether this view is still the active/visible workspace leaf. */
  isActive?: () => boolean;
}


// ED-MAIN-007: an async clipboard request freezes its owner generation and
// request token. A request whose owner moved on (focus left without an
// authorizing menu, another leaf became active, or a newer request started)
// must not edit, focus, or record history, but its already-performed OS effect
// is still observed through the frozen endpoint.
export const clipboardOwnerGenerationByView = new WeakMap<EditorView, { generation: number }>();

export const clipboardRequestTokenByView = new WeakMap<EditorView, number>();


export function clipboardOwnerGeneration(view: EditorView): number {
  return clipboardOwnerGenerationByView.get(view)?.generation ?? 0;
}


export function bumpClipboardOwnerGeneration(view: EditorView): void {
  const state = clipboardOwnerGenerationByView.get(view) ?? { generation: 0 };
  state.generation += 1;
  clipboardOwnerGenerationByView.set(view, state);
}


export function nextClipboardRequestToken(view: EditorView): number {
  const next = (clipboardRequestTokenByView.get(view) ?? 0) + 1;
  clipboardRequestTokenByView.set(view, next);
  return next;
}


export function clipboardRequestIsCurrent(view: EditorView, token: number): boolean {
  return (clipboardRequestTokenByView.get(view) ?? 0) === token;
}


export function clipboardOwnerLost(
  view: EditorView,
  endpoint: ClipboardObservationEndpoint | undefined,
  ownerGenerationAtRequest: number,
  requestToken: number,
): boolean {
  if (!view.dom.isConnected) return true;
  if (endpoint?.isActive && !endpoint.isActive()) return true;
  if (!clipboardRequestIsCurrent(view, requestToken)) return true;
  // ED-REPAIR-008: owner generation change is strictly irreversible. If focus
  // left or generation bumped after the request started, returning focus to the
  // editor does not restore ownership.
  if (clipboardOwnerGeneration(view) !== ownerGenerationAtRequest) {
    return true;
  }
  return false;
}


export function watchClipboardRequestFocus(view: EditorView): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  const activeElementAtRequest = document.activeElement;
  const isEditorFocusedAtRequest =
    view.hasFocus || (activeElementAtRequest !== null && view.contentDOM.contains(activeElementAtRequest));

  const menuContainer = !isEditorFocusedAtRequest && activeElementAtRequest
    ? (activeElementAtRequest.closest(
        '[role="menu"], [role="menubar"], [data-testid*="menu"], .context-menu, [data-context-menu], dialog'
      ) ?? activeElementAtRequest)
    : null;

  let cleanedUp = false;
  const onFocusIn = (event: FocusEvent) => {
    if (cleanedUp) return;
    const target = event.target as Node | null;
    if (!target) return;
    if (target === document.body || target === document.documentElement) return;
    if (target instanceof Element && (target.hasAttribute("data-clipboard-internal-fallback") || (target as HTMLElement).style?.left === "-9999px")) return;
    if (view.contentDOM.contains(target)) return;
    if (isEditorFocusedAtRequest) {
      bumpClipboardOwnerGeneration(view);
      cleanup();
      return;
    }
    if (activeElementAtRequest && (activeElementAtRequest === target || activeElementAtRequest.contains(target))) {
      return;
    }
    if (menuContainer && menuContainer.contains(target)) {
      return;
    }
    bumpClipboardOwnerGeneration(view);
    cleanup();
  };

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    window.removeEventListener("focusin", onFocusIn, true);
  };

  window.addEventListener("focusin", onFocusIn, true);
  return cleanup;
}


/**
 * ED-CLIP-004: project one settled guarded clipboard result into the typed
 * observation seam. Copy/cut report the local payload shape; paste reports the
 * shape of whatever was actually inserted (OS text or workspace fallback).
 */
export function reportClipboardWriteObservation(
  context: ClipboardObservationEndpoint | undefined,
  operation: ClipboardObservationOperation,
  result: GuardedSystemWriteResult,
  payload: EditorClipboardPayload,
  caretCount: number,
): void {
  if (!context?.onObservation) return;
  const handle = context.handle;
  const snapshot = handle?.getSnapshot();
  context.onObservation(createClipboardWriteObservation({
    operation,
    result,
    payload: {
      plainText: payload.plainText,
      segments: payload.segments,
      rectangular: payload.rectangular,
    },
    permission: snapshot?.permission ?? "unknown",
    permissionGeneration: snapshot?.permissionGeneration ?? 0,
    historyExclusion: snapshot?.exclusion ?? "recorded",
    payloadRevision: snapshot?.payloadRevision ?? 0,
    caretCount,
  }));
}


export function reportClipboardReadObservation(
  context: ClipboardObservationEndpoint | undefined,
  operation: ClipboardObservationOperation,
  result: GuardedSystemReadResult,
  caretCount: number,
): void {
  if (!context?.onObservation) return;
  const handle = context.handle;
  const snapshot = handle?.getSnapshot();
  context.onObservation(createClipboardReadObservation({
    operation,
    result,
    permission: snapshot?.permission ?? "unknown",
    permissionGeneration: snapshot?.permissionGeneration ?? 0,
    historyExclusion: snapshot?.exclusion ?? "recorded",
    payloadRevision: snapshot?.payloadRevision ?? 0,
    caretCount,
  }));
}


/**
 * ED-IMPROVE-009: report a late clipboard result whose owner moved on, keeping
 * the OS effect that already happened instead of dropping the observation.
 */
export function reportClipboardCancelledObservation(
  endpoint: ClipboardObservationEndpoint | undefined,
  operation: ClipboardObservationOperation,
  systemEffect: GuardedSystemEffect,
  caretCount: number,
  shape: {
    baseGeneration?: number | null;
    usedWorkspaceFallback?: boolean;
    segmentCount?: number | null;
    rectangular?: boolean;
    payloadLength?: number | null;
  } = {},
): void {
  if (!endpoint?.onObservation) return;
  const snapshot = endpoint.handle?.getSnapshot();
  endpoint.onObservation(createClipboardCancelledObservation({
    operation,
    systemEffect,
    permission: snapshot?.permission ?? "unknown",
    permissionGeneration: snapshot?.permissionGeneration ?? 0,
    historyExclusion: snapshot?.exclusion ?? "recorded",
    payloadRevision: snapshot?.payloadRevision ?? 0,
    caretCount,
    ...shape,
  }));
}


export type ClipboardStoreLike = Pick<WorkspaceClipboardHandle, "write" | "read" | "pasteFromHistory">
  & Partial<Pick<WorkspaceClipboardHandle, "historyExclusion">>;


export function workspaceStoreFor(
  context: { workspaceId: string | null; handle: WorkspaceClipboardHandle | null } | undefined,
): ClipboardStoreLike | null {
  return context?.handle ?? null;
}


export function rememberEditorClipboardPayload(
  view: EditorView,
  payload: EditorClipboardPayload,
  options: { systemClipboardUnavailable?: boolean } = {},
): void {
  // WeakMap stays as a compat read for legacy call paths only; the workspace
  // session store below is the owner shared across split views (§8.17.6).
  editorClipboardPayloadByView.set(view, {
    ...payload,
    segments: payload.segments ? [...payload.segments] : undefined,
  });
  const context = clipboardContextByView.get(view);
  const store = workspaceStoreFor(context);
  if (store) {
    store.write({
      sourceViewId: String(view.dom.getAttribute("data-cm-id") ?? ""),
      plainText: payload.plainText,
      segments: payload.segments,
      rectangular: payload.rectangular,
      sourceEol: payload.sourceEol,
      ...(options.systemClipboardUnavailable ? { systemClipboardUnavailable: true } : {}),
    });
    // §8.19.5 non-blocking notice when the ring declined the payload.
    const exclusion = store.historyExclusion?.() ?? "recorded";
    if (exclusion === "sensitive") {
      context?.onUnavailable("Sensitive content was kept out of clipboard history");
    } else if (exclusion === "oversized-item") {
      context?.onUnavailable("Oversized content was kept out of clipboard history");
    }
  }
}


export function payloadForSystemClipboardText(
  view: EditorView,
  text: string,
): EditorClipboardPayload {
  // Workspace session first: a copy in ANOTHER split view must still paste
  // with its segments/rectangular shape here.
  const context = clipboardContextByView.get(view);
  const store = workspaceStoreFor(context);
  const session = store ? store.read() : null;
  if (session && session.plainText === text && (session.segments?.length || session.rectangular)) {
    return {
      plainText: session.plainText,
      segments: session.segments ?? undefined,
      sourceEol: session.sourceEol,
      rectangular: session.rectangular,
    };
  }
  const remembered = editorClipboardPayloadByView.get(view);
  return remembered?.plainText === text
    ? remembered
    : plainTextClipboardPayload(text);
}


export function writeEditorSelectionToClipboard(view: EditorView): boolean {
  const payload = editorClipboardPayload(view.state);
  if (!payload) return false;
  const docAtRequest = view.state.doc;
  const selectionAtRequest = view.state.selection;
  const rawContext = clipboardContextByView.get(view);
  const context = rawContext ? { ...rawContext } : undefined;
  const handle = context?.handle;
  const requestToken = nextClipboardRequestToken(view);
  const ownerGenerationAtRequest = clipboardOwnerGeneration(view);
  const caretCountAtCopy = view.state.selection.ranges.length;
  const cleanupFocusWatcher = watchClipboardRequestFocus(view);

  if (handle) {
    void handle.writeSystemClipboard(payload.plainText).then((res) => {
      if (
        clipboardOwnerLost(view, context, ownerGenerationAtRequest, requestToken)
        || view.state.doc !== docAtRequest
        || !view.state.selection.eq(selectionAtRequest, true)
      ) {
        reportClipboardCancelledObservation(context, "copy", res.systemEffect, caretCountAtCopy, {
          segmentCount: payload.segments ? payload.segments.length : null,
          rectangular: payload.rectangular,
          payloadLength: payload.plainText.length,
        });
        return;
      }
      if (res.outcome === "success") {
        rememberEditorClipboardPayload(view, payload);
      } else if (res.outcome === "denied") {
        rememberEditorClipboardPayload(
          view,
          payload,
          res.systemEffect === "performed" ? {} : { systemClipboardUnavailable: true },
        );
        context?.onUnavailable(
          res.systemEffect === "performed"
            ? "System clipboard permission was denied after the copy completed"
            : "System clipboard access denied — copy kept for in-workspace paste only",
        );
      } else if (res.outcome === "stale-generation") {
        rememberEditorClipboardPayload(
          view,
          payload,
          res.systemEffect === "performed" ? {} : { systemClipboardUnavailable: true },
        );
        context?.onUnavailable(
          res.systemEffect === "performed"
            ? "Clipboard permission changed after the system clipboard copy completed"
            : "Clipboard permission changed during copy — system clipboard effect is unknown; copy kept for in-workspace paste",
        );
      } else {
        rememberEditorClipboardPayload(view, payload, { systemClipboardUnavailable: true });
        context?.onUnavailable(
          "System clipboard write effect is unknown — copy kept for in-workspace paste",
        );
      }
      // Reported after the payload landed in the slot so the observation's
      // revision/exclusion fields describe the committed state, not the
      // pre-write one.
      reportClipboardWriteObservation(context, "copy", res, payload, caretCountAtCopy);
    }).catch(() => {}).finally(() => {
      cleanupFocusWatcher();
    });
    return true;
  }
  void writeText(payload.plainText)
    .then(() => {
      if (
        clipboardOwnerLost(view, context, ownerGenerationAtRequest, requestToken)
        || view.state.doc !== docAtRequest
        || !view.state.selection.eq(selectionAtRequest, true)
      ) {
        reportClipboardCancelledObservation(context, "copy", "unknown", caretCountAtCopy, {
          segmentCount: payload.segments ? payload.segments.length : null,
          rectangular: payload.rectangular,
          payloadLength: payload.plainText.length,
        });
        return;
      }
      rememberEditorClipboardPayload(view, payload);
    })
    .catch(() => {
      if (
        clipboardOwnerLost(view, context, ownerGenerationAtRequest, requestToken)
        || view.state.doc !== docAtRequest
        || !view.state.selection.eq(selectionAtRequest, true)
      ) {
        return;
      }
      // System clipboard denied: the workspace session still owns the full
      // payload; surface unavailable instead of silently dropping it.
      rememberEditorClipboardPayload(view, payload, { systemClipboardUnavailable: true });
      context?.onUnavailable(
        "System clipboard unavailable — copy kept for in-workspace paste only",
      );
    })
    .finally(() => {
      cleanupFocusWatcher();
    });
  return true;
}


export function readCodeWorkspaceClipboardText() {
  // Linux/WebKitGTK can return an old in-process clipboard value after the
  // current X11 owner rejects conversion. Cross the Rust boundary there so a
  // real denial stays observable. Keep the established macOS/Windows strategy
  // in readTextResult(): those platforms are outside this card's native matrix.
  return isTauriRuntime() && getAppPlatform() === "linux"
    ? readNativeTextResult()
    : readTextResult();
}


export function pasteSystemClipboard(view: EditorView): boolean {
  if (view.composing || view.state.readOnly) return false;
  const docAtRequest = view.state.doc;
  const selectionAtRequest = view.state.selection;
  const rawContext = clipboardContextByView.get(view);
  const context = rawContext ? { ...rawContext } : undefined;
  const handle = context?.handle;
  const requestToken = nextClipboardRequestToken(view);
  const ownerGenerationAtRequest = clipboardOwnerGeneration(view);

  const caretCountAtPaste = view.state.selection.ranges.length;
  const cleanupFocusWatcher = watchClipboardRequestFocus(view);

  if (handle) {
    void handle.readSystemClipboard({ readTextResult: readCodeWorkspaceClipboardText }).then((result) => {
      if (
        clipboardOwnerLost(view, context, ownerGenerationAtRequest, requestToken)
        || view.composing
        || view.state.readOnly
        || view.state.doc !== docAtRequest
        || !view.state.selection.eq(selectionAtRequest, true)
      ) {
        // ED-IMPROVE-009 / ED-MAIN-007: the paste is cancelled with no document
        // or focus effect, but the OS read effect that already happened is
        // still reported through the frozen endpoint.
        reportClipboardCancelledObservation(context, "paste", result.systemEffect, caretCountAtPaste, {
          baseGeneration: result.outcome === "stale-generation" ? result.baseGeneration : null,
          usedWorkspaceFallback: result.outcome !== "success" && !!result.fallbackSession,
          segmentCount: result.outcome === "success" ? null : result.fallbackSession?.segments?.length ?? null,
          rectangular: result.outcome === "success" ? false : result.fallbackSession?.rectangular ?? false,
          payloadLength: result.outcome === "success" ? result.text.length : result.fallbackSession?.plainText.length ?? null,
        });
        return;
      }
      reportClipboardReadObservation(context, "paste", result, caretCountAtPaste);
      if (result.outcome === "success") {
        pasteEditorClipboardPayload(
          view,
          payloadForSystemClipboardText(view, result.text),
        );
        view.focus();
      } else {
        const session = result.fallbackSession;
        if (session) {
          pasteEditorClipboardPayload(view, {
            plainText: session.plainText,
            segments: session.segments ?? undefined,
            sourceEol: session.sourceEol,
            rectangular: session.rectangular,
          });
          const reasonMsg = result.outcome === "denied"
            ? "System clipboard access denied — pasted from in-workspace session slot instead"
            : result.outcome === "stale-generation"
            ? "Clipboard permission changed during read — pasted from in-workspace session slot instead"
            : "System clipboard read result is unknown — pasted from in-workspace session slot instead";
          context?.onUnavailable(reasonMsg);
          view.focus();
        } else {
          const reasonMsg = result.outcome === "denied"
            ? "System clipboard access denied and no in-workspace clipboard session available"
            : result.outcome === "stale-generation"
            ? "Clipboard permission changed during read and no in-workspace clipboard session available"
            : "System clipboard read result is unknown and no in-workspace clipboard session available";
          context?.onUnavailable(reasonMsg);
        }
      }
    }).catch(() => {}).finally(() => {
      cleanupFocusWatcher();
    });
    return true;
  }

  void readCodeWorkspaceClipboardText()
    .then((result) => {
      if (
        clipboardOwnerLost(view, context, ownerGenerationAtRequest, requestToken)
        || view.composing
        || view.state.readOnly
        || view.state.doc !== docAtRequest
        || !view.state.selection.eq(selectionAtRequest, true)
      ) {
        // ED-IMPROVE-009 / ED-MAIN-007: cancelled paste keeps the OS read fact.
        reportClipboardCancelledObservation(
          context,
          "paste",
          result.ok ? "not-performed" : "unknown",
          caretCountAtPaste,
          { payloadLength: result.ok ? result.text.length : null },
        );
        return;
      }
      {
        if (!result.ok) {
          const fallbackStore = workspaceStoreFor(context);
          const session = fallbackStore ? fallbackStore.read() : null;
          if (session) {
            // System clipboard read failed; the workspace session preserves
            // the last copy/cut (segments intact) with an explicit notice.
            pasteEditorClipboardPayload(view, {
              plainText: session.plainText,
              segments: session.segments ?? undefined,
              sourceEol: session.sourceEol,
              rectangular: session.rectangular,
            });
            context?.onUnavailable(
              "System clipboard read did not complete — pasted from in-workspace session slot instead",
            );
            view.focus();
          } else {
            context?.onUnavailable(
              "System clipboard read did not complete and no in-workspace clipboard session available",
            );
          }
          return;
        }
      }
      pasteEditorClipboardPayload(
        view,
        payloadForSystemClipboardText(view, result.text),
      );
      view.focus();
    })
    .catch(() => {})
    .finally(() => {
      cleanupFocusWatcher();
    });
  return true;
}


/**
 * §8.19.5 / §8.21.3 Plain Paste: internal rectangular/segment metadata is deliberately
 * dropped — the system (or in-workspace fallback) text inserts as ONE plain
 * string per caret in a single dispatch, so one undo restores everything.
 */
export function pasteAsPlainText(view: EditorView): boolean {
  if (view.composing || view.state.readOnly) return false;
  const docAtRequest = view.state.doc;
  const selectionAtRequest = view.state.selection;
  const rawContext = clipboardContextByView.get(view);
  const context = rawContext ? { ...rawContext } : undefined;
  const handle = context?.handle;
  const requestToken = nextClipboardRequestToken(view);
  const ownerGenerationAtRequest = clipboardOwnerGeneration(view);

  const caretCountAtPlainPaste = view.state.selection.ranges.length;
  const cleanupFocusWatcher = watchClipboardRequestFocus(view);

  if (handle) {
    void handle.readSystemClipboard({ readTextResult: readCodeWorkspaceClipboardText }).then((result) => {
      if (
        clipboardOwnerLost(view, context, ownerGenerationAtRequest, requestToken)
        || view.composing
        || view.state.readOnly
        || view.state.doc !== docAtRequest
        || !view.state.selection.eq(selectionAtRequest, true)
      ) {
        reportClipboardCancelledObservation(context, "paste-plain", result.systemEffect, caretCountAtPlainPaste, {
          baseGeneration: result.outcome === "stale-generation" ? result.baseGeneration : null,
          usedWorkspaceFallback: result.outcome !== "success" && !!result.fallbackSession,
          payloadLength: result.outcome === "success" ? result.text.length : result.fallbackSession?.plainText.length ?? null,
        });
        return;
      }
      reportClipboardReadObservation(context, "paste-plain", result, caretCountAtPlainPaste);
      const text = result.outcome === "success" ? result.text : result.fallbackSession?.plainText ?? "";
      if (!text) {
        context?.onUnavailable(
          result.outcome === "success"
            ? "Nothing to paste"
            : result.outcome === "denied"
            ? "System clipboard access denied and no in-workspace clipboard session available"
            : "System clipboard read result is unknown and no in-workspace clipboard session available",
        );
        return;
      }
      const ranges = [...view.state.selection.ranges].sort((a, b) => a.from - b.from);
      view.dispatch({
        changes: ranges.map((range) => ({ from: range.from, to: range.to, insert: text })),
        userEvent: "input.paste.plain",
        scrollIntoView: true,
      });
      if (result.outcome !== "success" && result.fallbackSession) {
        context?.onUnavailable(
          "System clipboard access denied — pasted from in-workspace session slot as plain text",
        );
      }
      view.focus();
    }).catch(() => {}).finally(() => {
      cleanupFocusWatcher();
    });
    return true;
  }

  void readCodeWorkspaceClipboardText()
    .then((result) => {
      if (
        clipboardOwnerLost(view, context, ownerGenerationAtRequest, requestToken)
        || view.composing
        || view.state.readOnly
        || view.state.doc !== docAtRequest
        || !view.state.selection.eq(selectionAtRequest, true)
      ) {
        reportClipboardCancelledObservation(
          context,
          "paste-plain",
          result.ok ? "not-performed" : "unknown",
          caretCountAtPlainPaste,
          { payloadLength: result.ok ? result.text.length : null },
        );
        return;
      }
      const session = workspaceStoreFor(context)?.read() ?? null;
      const text = result.ok ? result.text : session?.plainText ?? "";
      if (!text) {
        context?.onUnavailable(
          result.ok ? "Nothing to paste" : "System clipboard read did not complete and no in-workspace clipboard session available",
        );
        return;
      }
      // Ascending per-caret replacement of the same full text; no segments,
      // no rectangular plan, no cycling.
      const ranges = [...view.state.selection.ranges].sort((a, b) => a.from - b.from);
      view.dispatch({
        changes: ranges.map((range) => ({ from: range.from, to: range.to, insert: text })),
        userEvent: "input.paste.plain",
        scrollIntoView: true,
      });
      if (!result.ok && session) {
        context?.onUnavailable(
          "System clipboard access denied — pasted from in-workspace session slot as plain text",
        );
      }
      view.focus();
    })
    .catch(() => {})
    .finally(() => {
      cleanupFocusWatcher();
    });
  return true;
}


export function cutSystemClipboard(view: EditorView): boolean {
  if (view.composing || view.state.readOnly) return false;
  const payload = editorClipboardPayload(view.state);
  if (!payload) return false;
  const docAtRequest = view.state.doc;
  const selectionAtRequest = view.state.selection;
  const rawContext = clipboardContextByView.get(view);
  const context = rawContext ? { ...rawContext } : undefined;
  const handle = context?.handle;
  const requestToken = nextClipboardRequestToken(view);
  const ownerGenerationAtRequest = clipboardOwnerGeneration(view);

  const caretCountAtCut = view.state.selection.ranges.length;
  const cleanupFocusWatcher = watchClipboardRequestFocus(view);

  if (handle) {
    void handle.writeSystemClipboard(payload.plainText).then((res) => {
      if (
        clipboardOwnerLost(view, context, ownerGenerationAtRequest, requestToken)
        || view.composing
        || view.state.readOnly
        || view.state.doc !== docAtRequest
        || !view.state.selection.eq(selectionAtRequest, true)
      ) {
        // ED-IMPROVE-009 / ED-MAIN-007: the cut is cancelled with no document
        // or focus effect, but a possibly-performed OS write keeps its fact.
        reportClipboardCancelledObservation(context, "cut", res.systemEffect, caretCountAtCut, {
          baseGeneration: res.outcome === "stale-generation" ? res.baseGeneration : null,
          segmentCount: payload.segments ? payload.segments.length : null,
          rectangular: payload.rectangular,
          payloadLength: payload.plainText.length,
        });
        return;
      }
      if (res.outcome === "success") {
        rememberEditorClipboardPayload(view, payload);
        cutEditorSelections(view);
        view.focus();
      } else {
        rememberEditorClipboardPayload(
          view,
          payload,
          res.systemEffect === "performed" ? {} : { systemClipboardUnavailable: true },
        );
        cutEditorSelections(view);
        const reasonMsg = res.outcome === "denied"
          ? res.systemEffect === "performed"
            ? "System clipboard permission was denied after the cut copy completed"
            : "System clipboard access denied — cut kept for in-workspace paste only"
          : res.outcome === "stale-generation"
          ? res.systemEffect === "performed"
            ? "Clipboard permission changed after the system clipboard cut copy completed"
            : "Clipboard permission changed during cut — system clipboard effect is unknown; cut kept for in-workspace paste"
          : "System clipboard write effect is unknown — cut kept for in-workspace paste";
        context?.onUnavailable(reasonMsg);
        view.focus();
      }
      reportClipboardWriteObservation(context, "cut", res, payload, caretCountAtCut);
    }).catch(() => {}).finally(() => {
      cleanupFocusWatcher();
    });
    return true;
  }

  void writeText(payload.plainText)
    .then(() => {
      if (
        clipboardOwnerLost(view, context, ownerGenerationAtRequest, requestToken)
        || view.composing
        || view.state.readOnly
        || view.state.doc !== docAtRequest
        || !view.state.selection.eq(selectionAtRequest, true)
      ) {
        reportClipboardCancelledObservation(context, "cut", "unknown", caretCountAtCut, {
          segmentCount: payload.segments ? payload.segments.length : null,
          rectangular: payload.rectangular,
          payloadLength: payload.plainText.length,
        });
        return;
      }
      rememberEditorClipboardPayload(view, payload);
      cutEditorSelections(view);
      view.focus();
    })
    .catch(() => {
      if (
        clipboardOwnerLost(view, context, ownerGenerationAtRequest, requestToken)
        || view.composing
        || view.state.readOnly
        || view.state.doc !== docAtRequest
        || !view.state.selection.eq(selectionAtRequest, true)
      ) {
        return;
      }
      rememberEditorClipboardPayload(view, payload, { systemClipboardUnavailable: true });
      cutEditorSelections(view);
      context?.onUnavailable(
        "System clipboard unavailable — cut kept for in-workspace paste only",
      );
      view.focus();
    })
    .finally(() => {
      cleanupFocusWatcher();
    });
  return true;
}
