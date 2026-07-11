import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import {
  getPrimaryFontName,
  isMonospaceFont,
  makeTerminalFontFamily,
  resolveSelectedFontName,
  SAFE_TERMINAL_FONT_FALLBACKS,
  useSystemFonts,
  useTerminalFontOptions,
} from "../../lib/systemFonts";
import { ThemePreviewList, type ThemePreviewOption } from "../theme/ThemePreviewSelect";
import { FontPickerSelect, type FontPickerOption } from "./FontPickerPanel";

const MIXED_FONT_VALUE = "__mixed_font__";

export interface TerminalAppearanceMenuLabels {
  font: string;
  mixedFont: string;
  monospaceFonts: string;
  proportionalFonts: string;
  textSize: string;
  decreaseTextSize: string;
  increaseTextSize: string;
  fontSize: string;
}

export const DEFAULT_TERMINAL_APPEARANCE_MENU_LABELS: TerminalAppearanceMenuLabels = {
  font: "Font",
  mixedFont: "Mixed fonts",
  monospaceFonts: "Monospace fonts",
  proportionalFonts: "Proportional fonts",
  textSize: "Text size",
  decreaseTextSize: "Decrease terminal font size",
  increaseTextSize: "Increase terminal font size",
  fontSize: "Terminal font size",
};

export function TerminalAppearanceMenuPanel({
  themeValue,
  themeOptions,
  fontFamily,
  fontSize,
  onChangeTheme,
  onChangeFontFamily,
  onChangeFontSize,
  labels = DEFAULT_TERMINAL_APPEARANCE_MENU_LABELS,
  themeListTestId = "terminal-context-theme-list",
  fontSelectTestId,
  fontSizeTestId,
}: {
  themeValue: string;
  themeOptions: ThemePreviewOption[];
  fontFamily: string | null;
  fontSize: number | null;
  onChangeTheme: (theme: string) => void;
  onChangeFontFamily: (fontFamily: string) => void;
  onChangeFontSize: (fontSize: number) => void;
  labels?: TerminalAppearanceMenuLabels;
  themeListTestId?: string;
  fontSelectTestId?: string;
  fontSizeTestId?: string;
}) {
  const [fontCatalogRequested, setFontCatalogRequested] = useState(false);
  const fontState = useSystemFonts(fontCatalogRequested);
  const currentPrimaryFont = fontFamily ? getPrimaryFontName(fontFamily) : null;
  const fontOptions = useTerminalFontOptions(
    [
      ...(fontState.fonts.length > 0 ? fontState.fonts : SAFE_TERMINAL_FONT_FALLBACKS),
      ...(currentPrimaryFont ? [currentPrimaryFont] : []),
    ],
  );
  const [draftThemeValue, setDraftThemeValue] = useState(themeValue);
  const [draftFontFamily, setDraftFontFamily] = useState<string | null>(fontFamily);
  const [draftFontSize, setDraftFontSize] = useState<number | null>(fontSize);
  const draftFontSizeRef = useRef<number | null>(fontSize);
  const selectedFont = draftFontFamily ? resolveSelectedFontName(draftFontFamily, fontOptions) : MIXED_FONT_VALUE;
  const [fontSizeText, setFontSizeText] = useState(draftFontSize === null ? "" : String(draftFontSize));
  const fontPickerOptions = useMemo<FontPickerOption[]>(() => [
    ...(!draftFontFamily ? [{ value: MIXED_FONT_VALUE, label: labels.mixedFont, group: "mixed" }] : []),
    ...fontOptions.map((font) => ({
      value: font,
      label: font,
      fontFamily: `"${font}", monospace`,
    })),
  ], [draftFontFamily, fontOptions, labels.mixedFont]);
  const fontGroupLabels = useMemo(() => ({
    mixed: "",
    mono: labels.monospaceFonts,
    proportional: labels.proportionalFonts,
  }), [labels.monospaceFonts, labels.proportionalFonts]);
  const fontGroupForOption = useCallback(
    (option: FontPickerOption) => isMonospaceFont(option.label) ? "mono" : "proportional",
    [],
  );

  useEffect(() => {
    setDraftThemeValue(themeValue);
  }, [themeValue]);

  useEffect(() => {
    setDraftFontFamily(fontFamily);
  }, [fontFamily]);

  useEffect(() => {
    setDraftFontSize(fontSize);
    draftFontSizeRef.current = fontSize;
  }, [fontSize]);

  useEffect(() => {
    setFontSizeText(draftFontSize === null ? "" : String(draftFontSize));
  }, [draftFontSize]);

  const updateFontSize = useCallback((next: number) => {
    if (!Number.isFinite(next)) return;
    const clamped = Math.max(8, Math.min(32, Math.round(next)));
    draftFontSizeRef.current = clamped;
    setDraftFontSize(clamped);
    setFontSizeText(String(clamped));
    onChangeFontSize(clamped);
  }, [onChangeFontSize]);

  const stepFontSize = useCallback((delta: number) => {
    const current = draftFontSizeRef.current;
    if (current === null) return;
    updateFontSize(current + delta);
  }, [updateFontSize]);

  return (
    <div className="w-[380px] max-w-[calc(100vw-24px)] max-h-[min(420px,calc(100vh-24px))] overflow-hidden rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] shadow-lg">
      <ThemePreviewList
        value={draftThemeValue}
        options={themeOptions}
        testId={themeListTestId}
        className="max-h-[min(270px,calc(100vh-170px))] overflow-y-auto overscroll-contain p-1"
        onChange={(nextTheme) => {
          setDraftThemeValue(nextTheme);
          onChangeTheme(nextTheme);
        }}
      />
      <div className="border-t border-[var(--taomni-divider)] p-2 space-y-2">
        <label className="block">
          <span className="block mb-1 text-[11px] font-semibold text-[var(--taomni-text-muted)]">{labels.font}</span>
          <FontPickerSelect
            ariaLabel={labels.font}
            testId={fontSelectTestId}
            options={fontPickerOptions}
            selectedValue={selectedFont}
            loading={fontCatalogRequested && fontState.loading}
            groupForOption={fontGroupForOption}
            groupLabels={fontGroupLabels}
            onOpen={() => setFontCatalogRequested(true)}
            onSelect={(font) => {
              if (font === MIXED_FONT_VALUE) return;
              const nextFontFamily = makeTerminalFontFamily(font);
              setDraftFontFamily(nextFontFamily);
              onChangeFontFamily(nextFontFamily);
            }}
          />
        </label>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold text-[var(--taomni-text-muted)]">{labels.textSize}</span>
          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              className="taomni-btn h-7 w-7 p-0 inline-flex items-center justify-center"
              aria-label={labels.decreaseTextSize}
              disabled={draftFontSize === null}
              onClick={() => stepFontSize(-1)}
            >
              <Minus className="w-3.5 h-3.5" />
            </button>
            <input
              className="taomni-input h-7 w-14 text-center"
              aria-label={labels.fontSize}
              data-testid={fontSizeTestId}
              inputMode="numeric"
              placeholder={draftFontSize === null ? "-" : undefined}
              value={fontSizeText}
              onChange={(event) => {
                const next = event.target.value;
                if (!/^\d*$/.test(next)) return;
                setFontSizeText(next);
                const parsed = Number(next);
                if (Number.isFinite(parsed) && parsed >= 8 && parsed <= 32) {
                  updateFontSize(parsed);
                }
              }}
              onBlur={() => {
                if (!fontSizeText) {
                  setFontSizeText(draftFontSize === null ? "" : String(draftFontSize));
                  return;
                }
                const parsed = Number(fontSizeText);
                if (Number.isFinite(parsed) && parsed > 0) {
                  const clamped = Math.max(8, Math.min(32, Math.round(parsed)));
                  updateFontSize(clamped);
                }
              }}
            />
            <button
              type="button"
              className="taomni-btn h-7 w-7 p-0 inline-flex items-center justify-center"
              aria-label={labels.increaseTextSize}
              disabled={draftFontSize === null}
              onClick={() => stepFontSize(1)}
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
