import { useCallback, useEffect, type MouseEvent as ReactMouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PanelRightClose } from "lucide-react";
import { closeCurrentDetachedWindow } from "../../lib/detachWindowing";
import { useT } from "../../lib/i18n";
import { isTauriRuntime } from "../../lib/runtime";
import { useNotesStore } from "../../stores/notesStore";
import { notesFontSizeStyle, notesFontStyle, notesThemeStyle } from "../../lib/notes/notesTheme";
import { NotesPanel } from "./NotesPanel";
import { emitNotesDockSignal, subscribeNotesDockSignal } from "../../lib/notes/notesWindowSync";
import { WindowResizeHandles } from "../window/WindowResizeHandles";

/**
 * NotesDetachedWindow — native OS-level window for notes when running inside Tauri runtime.
 * Styled to look clean like an aesthetic sticky note/memo strip with minimized controls.
 */
export function NotesDetachedWindow() {
  const t = useT();
  const setPanelMode = useNotesStore((s) => s.setPanelMode);
  const setPanelPosition = useNotesStore((s) => s.setPanelPosition);
  const theme = useNotesStore((s) => s.theme);
  const font = useNotesStore((s) => s.font);
  const fontSize = useNotesStore((s) => s.fontSize);

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

  useEffect(() => {
    return subscribeNotesDockSignal(closeDetachedNotesWindow);
  }, [closeDetachedNotesWindow]);

  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        event.preventDefault();
        void (async () => {
          await persistWindowGeometry();
          setPanelMode("hub");
          emitNotesDockSignal();
          closeDetachedNotesWindow();
        })();
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
  }, [closeDetachedNotesWindow, persistWindowGeometry, setPanelMode]);

  const dockToHub = () => {
    void (async () => {
      await persistWindowGeometry();
      setPanelMode("hub");
      emitNotesDockSignal();
      closeDetachedNotesWindow();
    })();
  };

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
          onClick={dockToHub}
          onMouseDown={(event) => event.stopPropagation()}
          title={t("notes.dock")}
          aria-label={t("notes.dock")}
          data-testid="notes-detached-dock"
          data-no-window-drag
        >
          <PanelRightClose className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        <NotesPanel showPanelModeToggle={false} />
      </div>
      <WindowResizeHandles className="absolute inset-0 z-20" edgeSize={5} cornerSize={10} />
      <div className="notes-sticky-fold" aria-hidden="true" />
    </div>
  );
}
