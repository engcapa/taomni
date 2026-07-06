import { Pin, Type } from "lucide-react";
import { useNotesStore, type NotesFont, type NotesTheme } from "../../stores/notesStore";
import { NOTES_THEMES, notesFontStyle, notesThemeStyle } from "../../lib/notes/notesTheme";
import { useT } from "../../lib/i18n";
import { ThemePreviewSelect } from "../theme/ThemePreviewSelect";
import { NotesThemeLinePreview } from "../theme/themePreviews";
import { NotesSelect } from "./NotesSelect";
import { useSystemFonts } from "../../lib/systemFonts";

/**
 * NoteThemeSettings — theme picker + in-app always-on-top, surfaced from the
 * notes toolbar gear (§9). Changes apply immediately and persist to note_prefs
 * via the store.
 */
export function NoteThemeSettings() {
  const t = useT();
  const theme = useNotesStore((s) => s.theme);
  const setTheme = useNotesStore((s) => s.setTheme);
  const themeStyle = notesThemeStyle(theme);
  const selectBg = themeStyle["--taomni-input-bg" as keyof typeof themeStyle] as string | undefined;
  const selectColor = themeStyle["--taomni-text" as keyof typeof themeStyle] as string | undefined;
  const selectBorder = themeStyle["--taomni-input-border" as keyof typeof themeStyle] as string | undefined;

  const font = useNotesStore((s) => s.font);
  const setFont = useNotesStore((s) => s.setFont);
  const fontSize = useNotesStore((s) => s.fontSize);
  const setFontSize = useNotesStore((s) => s.setFontSize);
  const alwaysOnTop = useNotesStore((s) => s.alwaysOnTopInApp);
  const setAlwaysOnTop = useNotesStore((s) => s.setAlwaysOnTop);
  const fontState = useSystemFonts();

  const themeOptions = NOTES_THEMES.map((th: NotesTheme) => ({
    value: th,
    label: t(`notes.theme_${th}`),
    preview: <NotesThemeLinePreview theme={th} />,
    testId: `note-theme-${th}`,
  }));

  const curatedUiFonts = [
    { value: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', label: "Inter (Default UI - Highly Recommended)", style: { fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' } },
    { value: '"Outfit", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', label: "Outfit (Geometric Elegant)", style: { fontFamily: '"Outfit", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' } },
    { value: '"Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif', label: "Segoe UI (Windows Default)", style: { fontFamily: '"Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif' } },
    { value: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', label: "SF Pro / San Francisco (macOS Default)", style: { fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' } },
    { value: '"Ubuntu", "DejaVu Sans", sans-serif', label: "Ubuntu (Linux Default)", style: { fontFamily: '"Ubuntu", "DejaVu Sans", sans-serif' } },
    { value: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif', label: "System UI Default", style: { fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif' } },
  ];

  const notesPresets = [
    { value: "inherit", label: t("notes.font_inherit"), style: notesFontStyle("inherit") },
    { value: "system", label: t("notes.font_system"), style: notesFontStyle("system") },
    { value: "rounded", label: t("notes.font_rounded"), style: notesFontStyle("rounded") },
    { value: "serif", label: t("notes.font_serif"), style: notesFontStyle("serif") },
    { value: "songti", label: t("notes.font_songti"), style: notesFontStyle("songti") },
    { value: "kaiti", label: t("notes.font_kaiti"), style: notesFontStyle("kaiti") },
    { value: "handwriting", label: t("notes.font_handwriting"), style: notesFontStyle("handwriting") },
    { value: "mono", label: t("notes.font_mono"), style: notesFontStyle("mono") },
  ];

  const fontOptions = [
    ...notesPresets.map((f) => ({
      value: f.value,
      label: f.label,
      group: t("settings.fontFamilyCurated"),
      style: f.style,
    })),
    ...curatedUiFonts.map((f) => ({
      value: f.value,
      label: f.label,
      group: t("settings.fontFamilyCurated"),
      style: f.style,
    })),
    ...fontState.fonts.map((f) => ({
      value: `"${f}", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`,
      label: f,
      group: t("settings.fontFamilySystem"),
      style: { fontFamily: `"${f}"` },
    })),
  ];

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
          title={t("notes.theme")}
          onChange={(next) => setTheme(next as NotesTheme)}
        />
      </div>

      {/* Font */}
      <label className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1 text-[var(--taomni-text-muted)]">
          <Type className="w-3 h-3" />
          {t("notes.font")}
        </span>
        <NotesSelect
          className="flex-1 min-w-0"
          value={font}
          options={fontOptions}
          onChange={(val) => setFont(val as NotesFont)}
          testId="note-font-select"
          ariaLabel={t("notes.font")}
          title={t("notes.font")}
          selectBg={selectBg}
          selectColor={selectColor}
          selectBorder={selectBorder}
        />
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
