import type { EditorView } from "@codemirror/view";
import type { RefObject } from "react";
import type { PersistedEditorViewState } from "../workspaceLayoutPersistence";
import { applyPersistedEditorViewState, captureEditorViewState } from "./viewState";

interface ViewStateRefs {
  viewRef: RefObject<EditorView | null>;
  restoringInitialViewStateRef: RefObject<boolean>;
  userInteractedSinceMountRef: RefObject<boolean>;
  pendingDeferredScrollRef: RefObject<{ scrollTop: number; scrollLeft: number } | null>;
  lastEmittedViewStateRef: RefObject<string | null>;
}

interface ViewStateLifecycleContext {
  view: EditorView;
  refs: ViewStateRefs;
  documentReady: boolean;
  initialState: PersistedEditorViewState | null;
  callback: { callback: ((state: PersistedEditorViewState) => void) | undefined };
  onRestored: (view: EditorView) => void;
}

/** One activation of one file in one leaf, even when its EditorView is reused. */
export function createEditorViewStateLifecycle(context: ViewStateLifecycleContext) {
  const { view, refs, callback } = context;
  let ready = context.documentReady;
  let initialized = false;
  let disposed = false;
  let interacted = false;
  let timer: number | null = null;
  const canCapture = () => !disposed && ready && initialized && refs.viewRef.current === view;

  const flush = () => {
    if (!canCapture() || !callback.callback) return;
    try {
      const captured = captureEditorViewState(view);
      const serialized = JSON.stringify(captured);
      if (serialized === refs.lastEmittedViewStateRef.current) return;
      refs.lastEmittedViewStateRef.current = serialized;
      callback.callback(captured);
    } catch {
      // A window close can race native WebView teardown.
    }
  };
  const clearTimer = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
  const schedule = (_view: EditorView, delay = 150) => {
    if (!canCapture() || !callback.callback) return;
    clearTimer();
    timer = window.setTimeout(() => {
      timer = null;
      flush();
    }, delay);
  };
  const cancelDeferredRestore = () => {
    interacted = true;
    refs.userInteractedSinceMountRef.current = true;
    refs.pendingDeferredScrollRef.current = null;
  };
  view.scrollDOM.addEventListener("wheel", cancelDeferredRestore, { passive: true });
  view.scrollDOM.addEventListener("pointerdown", cancelDeferredRestore, { passive: true });
  view.contentDOM.addEventListener("keydown", cancelDeferredRestore);
  view.contentDOM.addEventListener("beforeinput", cancelDeferredRestore);

  return {
    canCapture,
    flush,
    schedule,
    restoreWhenReady(documentReady: boolean) {
      ready = documentReady;
      if (disposed || initialized || !ready || refs.viewRef.current !== view) return;
      initialized = true;
      // A loading placeholder must never consume a persisted snapshot. The
      // caller invokes this again after the real document is reconciled.
      if (context.initialState && !interacted) {
        refs.userInteractedSinceMountRef.current = false;
        refs.restoringInitialViewStateRef.current = true;
        try {
          const result = applyPersistedEditorViewState(view, context.initialState);
          refs.pendingDeferredScrollRef.current = result.deferredScroll;
        } finally {
          refs.restoringInitialViewStateRef.current = false;
        }
        view.requestMeasure();
        context.onRestored(view);
      }
    },
    dispose() {
      clearTimer();
      flush();
      disposed = true;
      view.scrollDOM.removeEventListener("wheel", cancelDeferredRestore);
      view.scrollDOM.removeEventListener("pointerdown", cancelDeferredRestore);
      view.contentDOM.removeEventListener("keydown", cancelDeferredRestore);
      view.contentDOM.removeEventListener("beforeinput", cancelDeferredRestore);
    },
  };
}

export type EditorViewStateLifecycle = ReturnType<typeof createEditorViewStateLifecycle>;
