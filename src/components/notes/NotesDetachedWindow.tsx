import { useEffect } from "react";
import { X } from "lucide-react";
import { closeCurrentDetachedWindow } from "../../lib/detachWindowing";
import { useT } from "../../lib/i18n";
import { useNotesStore } from "../../stores/notesStore";
import { notesFontSizeStyle, notesFontStyle, notesThemeStyle } from "../../lib/notes/notesTheme";
import { NotesPanel } from "./NotesPanel";

/**
 * NotesDetachedWindow — native OS-level window for notes when running inside Tauri runtime.
 * Styled to look clean like an aesthetic sticky note/memo strip with minimized controls.
 */
export function NotesDetachedWindow() {
  const t = useT();
  const setPanelMode = useNotesStore((s) => s.setPanelMode);
  const theme = useNotesStore((s) => s.theme);
  const font = useNotesStore((s) => s.font);
  const fontSize = useNotesStore((s) => s.fontSize);

  useEffect(() => {
    document.title = `${t("notes.title")} - taomni`;
  }, [t]);

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
        className="h-6 shrink-0 flex items-center gap-2 px-2"
        style={{ background: "rgba(0, 0, 0, 0.05)" }}
        data-testid="notes-detached-toolbar"
      >
        <span className="flex-1 min-w-0 truncate text-[11px] font-medium opacity-65">{t("notes.title")}</span>
        <button
          type="button"
          className="taomni-btn h-4 w-4 p-0 inline-flex items-center justify-center rounded hover:bg-black/10 hover:text-red-500"
          onClick={dockToHub}
          title={t("notes.dock")}
          aria-label={t("notes.dock")}
          data-testid="notes-detached-dock"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        <NotesPanel />
      </div>
      <div className="notes-sticky-fold" aria-hidden="true" />
    </div>
  );
}
