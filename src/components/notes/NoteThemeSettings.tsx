import { Monitor, PanelRightClose, Pin, Type } from "lucide-react";
import { useNotesStore, type NotesFont, type NotesTheme } from "../../stores/notesStore";
import { NOTES_FONTS, NOTES_THEMES } from "../../lib/notes/notesTheme";
import { useT } from "../../lib/i18n";
import { ThemePreviewSelect } from "../theme/ThemePreviewSelect";
import { NotesThemeLinePreview } from "../theme/themePreviews";
import { isTauriRuntime } from "../../lib/runtime";
import { openDetachedWindow } from "../../lib/detachWindowing";

/**
 * NoteThemeSettings — theme picker + panel-mode toggle + in-app always-on-top,
 * surfaced from the notes toolbar gear (§9, §4.3). Changes apply immediately and
 * persist to note_prefs via the store.
 */
export function NoteThemeSettings() {
  const t = useT();
  const theme = useNotesStore((s) => s.theme);
  const setTheme = useNotesStore((s) => s.setTheme);
  const font = useNotesStore((s) => s.font);
  const setFont = useNotesStore((s) => s.setFont);
  const fontSize = useNotesStore((s) => s.fontSize);
  const setFontSize = useNotesStore((s) => s.setFontSize);
  const panelPosition = useNotesStore((s) => s.panelPosition);
  const panelMode = useNotesStore((s) => s.panelMode);
  const setPanelMode = useNotesStore((s) => s.setPanelMode);
  const alwaysOnTop = useNotesStore((s) => s.alwaysOnTopInApp);
  const setAlwaysOnTop = useNotesStore((s) => s.setAlwaysOnTop);
  const themeOptions = NOTES_THEMES.map((th: NotesTheme) => ({
    value: th,
    label: t(`notes.theme_${th}`),
    preview: <NotesThemeLinePreview theme={th} />,
    testId: `note-theme-${th}`,
  }));
  const openFloatingNotes = () => {
    if (isTauriRuntime() && panelMode === "floating") {
      void openDetachedWindow({
        kind: "notes",
        sessionId: "panel",
        title: t("notes.title"),
        width: panelPosition.width,
        height: panelPosition.height,
      }).catch((err) => {
        console.warn("notes: failed to open detached window", err);
      });
      return;
    }
    setPanelMode("floating");
  };

  return (
    <div
      className="p-2 flex flex-col gap-2 border-b border-[var(--taomni-divider)] shrink-0 text-[11px]"
      data-testid="note-theme-settings"
    >
      {/* Theme */}
      <div className="flex flex-col gap-1">
        <span className="text-[var(--taomni-text-muted)]">{t("notes.theme")}</span>
        <ThemePreviewSelect
          value={theme}
          options={themeOptions}
          ariaLabel={t("notes.theme")}
          testId="note-theme-select"
          onChange={(next) => setTheme(next as NotesTheme)}
        />
      </div>

      {/* Font */}
      <label className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1 text-[var(--taomni-text-muted)]">
          <Type className="w-3 h-3" />
          {t("notes.font")}
        </span>
        <select
          className="taomni-input h-6 flex-1 min-w-0 text-[11px]"
          value={font}
          onChange={(event) => setFont(event.target.value as NotesFont)}
          data-testid="note-font-select"
          aria-label={t("notes.font")}
        >
          {NOTES_FONTS.map((value: NotesFont) => (
            <option key={value} value={value}>
              {t(`notes.font_${value}`)}
            </option>
          ))}
        </select>
      </label>

      {/* Font size */}
      <label className="flex items-center gap-2">
        <span className="text-[var(--taomni-text-muted)]">{t("notes.fontSize")}</span>
        <input
          type="range"
          min="10"
          max="20"
          step="1"
          className="h-4 flex-1 min-w-0"
          style={{ accentColor: "var(--taomni-accent)" }}
          value={fontSize}
          onChange={(event) => setFontSize(Number(event.target.value))}
          data-testid="note-font-size-slider"
          aria-label={t("notes.fontSize")}
        />
        <span className="taomni-mono w-9 text-right tabular-nums">{fontSize}px</span>
      </label>

      {/* Panel mode */}
      <div className="flex items-center gap-2">
        <span className="text-[var(--taomni-text-muted)]">{t("notes.panelMode")}</span>
        <div className="inline-flex h-6 overflow-hidden rounded border border-[var(--taomni-divider)]">
          <button
            type="button"
            className={`h-full px-2 inline-flex items-center gap-1 border-r border-[var(--taomni-divider)] text-[10px] ${
              panelMode === "hub" ? "bg-[var(--taomni-selected)] text-[var(--taomni-accent)]" : "hover:bg-[var(--taomni-hover)]"
            }`}
            aria-pressed={panelMode === "hub"}
            data-testid="note-panel-mode-hub"
            onClick={() => setPanelMode("hub")}
          >
            <PanelRightClose className="w-3 h-3" />
            {t("notes.panelModeHub")}
          </button>
          <button
            type="button"
            className={`h-full px-2 inline-flex items-center gap-1 text-[10px] ${
              panelMode === "floating" ? "bg-[var(--taomni-selected)] text-[var(--taomni-accent)]" : "hover:bg-[var(--taomni-hover)]"
            }`}
            aria-pressed={panelMode === "floating"}
            data-testid="note-panel-mode-floating"
            onClick={openFloatingNotes}
          >
            <Monitor className="w-3 h-3" />
            {t("notes.panelModeFloating")}
          </button>
        </div>
      </div>

      {/* Always on top (in-app) */}
      <label className="inline-flex items-center gap-1.5 cursor-pointer">
        <input
          type="checkbox"
          checked={alwaysOnTop}
          onChange={(e) => setAlwaysOnTop(e.target.checked)}
          data-testid="note-always-on-top"
        />
        <Pin className="w-3 h-3 text-[var(--taomni-text-muted)]" />
        <span>{t("notes.alwaysOnTop")}</span>
      </label>
    </div>
  );
}
