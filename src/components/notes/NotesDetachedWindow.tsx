import { useCallback, useEffect, useState } from "react";
import { Maximize2, Minimize2, PanelRightClose } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { closeCurrentDetachedWindow } from "../../lib/detachWindowing";
import { isTauriRuntime } from "../../lib/runtime";
import { useT } from "../../lib/i18n";
import { useNotesStore } from "../../stores/notesStore";
import { notesFontSizeStyle, notesFontStyle, notesThemeStyle } from "../../lib/notes/notesTheme";
import { NotesPanel } from "./NotesPanel";

export function NotesDetachedWindow() {
  const t = useT();
  const setPanelMode = useNotesStore((s) => s.setPanelMode);
  const theme = useNotesStore((s) => s.theme);
  const font = useNotesStore((s) => s.font);
  const fontSize = useNotesStore((s) => s.fontSize);
  const [osFullscreen, setOsFullscreen] = useState(false);

  useEffect(() => {
    document.title = `${t("notes.title")} - taomni`;
  }, [t]);

  const toggleOsFullscreen = useCallback(async () => {
    if (isTauriRuntime()) {
      try {
        const window = getCurrentWindow();
        const next = !(await window.isFullscreen());
        await window.setFullscreen(next);
        setOsFullscreen(next);
      } catch {
        /* noop */
      }
      return;
    }
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        setOsFullscreen(false);
      } else {
        await document.documentElement.requestFullscreen();
        setOsFullscreen(true);
      }
    } catch {
      /* noop */
    }
  }, []);

  const dockToHub = () => {
    setPanelMode("hub");
    void closeCurrentDetachedWindow();
  };

  return (
    <div
      className="relative h-screen min-h-0 flex flex-col notes-sticky-window"
      style={{
        background: "var(--taomni-sidebar-bg)",
        color: "var(--taomni-text)",
        ...notesThemeStyle(theme),
        ...notesFontStyle(font),
        ...notesFontSizeStyle(fontSize),
      }}
      data-testid="notes-detached-window"
    >
      <div
        className="h-8 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--taomni-divider)]"
        style={{ background: "var(--taomni-panel-bg)" }}
        data-testid="notes-detached-toolbar"
      >
        <span className="flex-1 min-w-0 truncate text-[12px] font-semibold">{t("notes.title")}</span>
        <button
          type="button"
          className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center"
          onClick={toggleOsFullscreen}
          title={t("notes.osFullscreen")}
          aria-label={t("notes.osFullscreen")}
          data-testid="notes-detached-fullscreen"
        >
          {osFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
        </button>
        <button
          type="button"
          className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center"
          onClick={dockToHub}
          title={t("notes.dock")}
          aria-label={t("notes.dock")}
          data-testid="notes-detached-dock"
        >
          <PanelRightClose className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        <NotesPanel />
      </div>
      <div className="notes-sticky-fold" aria-hidden="true" />
    </div>
  );
}
