import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PanelRightClose } from "lucide-react";
import { closeCurrentDetachedWindow } from "../../lib/detachWindowing";
import { useT } from "../../lib/i18n";
import { isTauriRuntime } from "../../lib/runtime";
import { useNotesStore } from "../../stores/notesStore";
import { notesFontSizeStyle, notesFontStyle, notesThemeStyle } from "../../lib/notes/notesTheme";
import { NotesPanel } from "./NotesPanel";
import { subscribeNotesDockSignal } from "../../lib/notes/notesWindowSync";
import { clearDetachedHandoff, consumeDetachedHandoff, subscribePanelWindow } from "../../lib/detachedSession";
import { flushNotesEditor, restoreNotesView, snapshotNotesView, subscribeNotesViewChanges, validateNotesView } from "../../lib/notes/notesViewState";
import { matchesPanelWindow, signalPanelWindow, waitPanelWindow } from "../../lib/shell/panelWindowTransaction";
import type { NotesWindowPayload } from "../../lib/shell/notesPanelWindow";
import { WindowResizeHandles } from "../window/WindowResizeHandles";

/**
 * NotesDetachedWindow — native OS-level window for notes when running inside Tauri runtime.
 * Styled to look clean like an aesthetic sticky note/memo strip with minimized controls.
 */
export function NotesDetachedWindow() {
  const t = useT();
  const setPanelPosition = useNotesStore((s) => s.setPanelPosition);
  const theme = useNotesStore((s) => s.theme);
  const font = useNotesStore((s) => s.font);
  const fontSize = useNotesStore((s) => s.fontSize);
  const [payload] = useState(() => consumeDetachedHandoff<NotesWindowPayload>("notes", "panel"));
  const [committed, setCommitted] = useState(false), [error, setError] = useState<string | null>(null);
  const moving = useRef(false), committing = useRef(false);

  useEffect(() => {
    document.title = `${t("notes.title")} - taomni`;
  }, [t]);

  useEffect(() => {
    document.documentElement.classList.add("notes-detached-document");
    document.body.classList.add("notes-detached-document");
    document.getElementById("root")?.classList.add("notes-detached-root");
    return () => {
      document.documentElement.classList.remove("notes-detached-document");
      document.body.classList.remove("notes-detached-document");
      document.getElementById("root")?.classList.remove("notes-detached-root");
    };
  }, []);

  const closeDetachedNotesWindow = useCallback(() => {
    void closeCurrentDetachedWindow().catch(() => {
      window.close();
    });
  }, []);

  const persistWindowGeometry = useCallback(async () => {
    if (!isTauriRuntime()) return;
    try {
      const currentWindow = getCurrentWindow();
      const [position, size, scaleFactor] = await Promise.all([
        currentWindow.outerPosition(),
        currentWindow.innerSize(),
        currentWindow.scaleFactor(),
      ]);
      const logicalPosition = position.toLogical(scaleFactor);
      const logicalSize = size.toLogical(scaleFactor);
      setPanelPosition({
        x: Math.max(0, Math.round(logicalPosition.x)),
        y: Math.max(0, Math.round(logicalPosition.y)),
        width: Math.max(220, Math.round(logicalSize.width)),
        height: Math.max(220, Math.round(logicalSize.height)),
      });
    } catch {
      /* best effort: geometry is persisted for the next notes popup */
    }
  }, [setPanelPosition]);

  const dockToHub = useCallback(async () => {
    if (!payload || !committed || moving.current) return;
    moving.current = true; setError(null);
    try {
      await flushNotesEditor();
      await persistWindowGeometry();
      const ack = waitPanelWindow(payload.envelope, "reattached");
      signalPanelWindow(payload.envelope, "request-reattach", snapshotNotesView());
      await ack;
      clearDetachedHandoff("notes", "panel");
      closeDetachedNotesWindow();
    } catch (failure) { moving.current = false; setError(String(failure)); }
  }, [payload, committed, persistWindowGeometry, closeDetachedNotesWindow]);

  useEffect(() => subscribeNotesDockSignal(() => { void dockToHub(); }), [dockToHub]);
  useEffect(() => {
    if (!payload || !committed) return;
    // Keep the latest draft in the live parent. This is transient window recovery,
    // never a second writer of note data or layout persistence.
    const publish = () => signalPanelWindow(payload.envelope, "snapshot", snapshotNotesView());
    publish();
    const offDraft = subscribeNotesViewChanges(publish);
    const offSelection = useNotesStore.subscribe((state, previous) => {
      if (state.activeNoteId !== previous.activeNoteId) publish();
    });
    return () => { offDraft(); offSelection(); };
  }, [payload, committed]);
  useEffect(() => {
    if (!payload) return;
    const off = subscribePanelWindow((message) => {
      if (!matchesPanelWindow(payload.envelope, message.envelope)) return;
      if (message.envelope.event === "cancel") { closeDetachedNotesWindow(); return; }
      if (message.envelope.event === "request-focus") { if (isTauriRuntime()) void getCurrentWindow().show().then(() => getCurrentWindow().setFocus()); return; }
      if (message.envelope.event === "request-reattach") { void dockToHub(); return; }
      if (message.envelope.event === "commit" && !committing.current) {
        committing.current = true;
        const snapshot = validateNotesView(message.data);
        void (async () => {
          if (!snapshot) throw new Error("Invalid notes handoff");
          await restoreNotesView(snapshot); setCommitted(true); clearDetachedHandoff("notes", "panel");
          signalPanelWindow(payload.envelope, "committed");
        })().catch((failure) => { committing.current = false; setError(String(failure)); signalPanelWindow({ ...payload.envelope, errorCode: String(failure) }, "failed"); });
      }
    });
    return off;
  }, [payload, dockToHub, closeDetachedNotesWindow]);
  useEffect(() => {
    if (!payload) { setError("The notes handoff is unavailable. Reopen this window from Tao."); return; }
    let disposed = false;
    void restoreNotesView(payload.snapshot).then(() => { if (!disposed) signalPanelWindow(payload.envelope, "ready"); }).catch((failure) => {
      if (!disposed) { setError(String(failure)); signalPanelWindow({ ...payload.envelope, errorCode: String(failure) }, "failed"); }
    });
    return () => { disposed = true; };
  }, [payload]);

  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        event.preventDefault();
        if (committed) void dockToHub();
        else closeDetachedNotesWindow();
      })
      .then((next) => {
        if (disposed) next();
        else unlisten = next;
      })
      .catch(() => {
        /* close hook unavailable */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [dockToHub, committed, closeDetachedNotesWindow]);

  const startDrag = (event: ReactMouseEvent) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button,input,select,textarea,[data-no-window-drag]")) return;
    if (!target.closest("[data-window-drag]")) return;
    void getCurrentWindow().startDragging().catch(() => {});
  };

  return (
    <div
      className="relative h-screen min-h-0 flex flex-col notes-sticky-window notes-detached-window overflow-hidden"
      style={{
        background: "var(--taomni-sidebar-bg)",
        color: "var(--taomni-text)",
        ...notesThemeStyle(theme === "taomni" ? "sticky_bright" : theme),
        ...notesFontStyle(font),
        ...notesFontSizeStyle(fontSize),
      }}
      data-testid="notes-detached-window"
      data-phase={committed ? "ready" : "initializing"}
      data-operation-id={payload?.envelope.operationId}
    >
      <div
        className="h-7 shrink-0 flex items-center gap-1 px-1.5 select-none"
        style={{ background: "var(--taomni-chrome-bg)" }}
        data-testid="notes-detached-toolbar"
        data-window-drag
        onMouseDown={startDrag}
      >
        <div className="flex-1 h-full min-w-0" aria-hidden="true" data-window-drag />
        <button
          type="button"
          className="taomni-btn relative z-30 h-5 w-5 p-0 inline-flex items-center justify-center rounded hover:bg-black/10"
          onClick={() => void dockToHub()}
          disabled={!committed}
          onMouseDown={(event) => event.stopPropagation()}
          title={t("notes.dock")}
          aria-label={t("notes.dock")}
          data-testid="notes-detached-dock"
          data-no-window-drag
        >
          <PanelRightClose className="w-3.5 h-3.5" />
        </button>
      </div>
      {error && <p role="alert" data-testid="shell-notes-window-error" className="p-2 text-xs">{error}</p>}
      <div className="flex-1 min-h-0 flex flex-col" inert={!committed}>
        <NotesPanel showPanelModeToggle={false} />
      </div>
      <WindowResizeHandles className="absolute inset-0 z-20" edgeSize={5} cornerSize={10} />
      <div className="notes-sticky-fold" aria-hidden="true" />
    </div>
  );
}
