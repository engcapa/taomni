import { useEffect, useMemo, useState } from "react";
import { Minus, Plus } from "lucide-react";
import {
  isMonospaceFont,
  makeTerminalFontFamily,
  resolveSelectedFontName,
  SAFE_TERMINAL_FONT_FALLBACKS,
  useTerminalFontOptions,
} from "../../lib/systemFonts";
import { ThemePreviewList, type ThemePreviewOption } from "../theme/ThemePreviewSelect";

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
  fonts,
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
  fonts: string[];
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
  const fontOptions = useTerminalFontOptions(fonts.length > 0 ? fonts : SAFE_TERMINAL_FONT_FALLBACKS);
  const selectedFont = fontFamily ? resolveSelectedFontName(fontFamily, fontOptions) : MIXED_FONT_VALUE;
  const [fontSizeText, setFontSizeText] = useState(fontSize === null ? "" : String(fontSize));
  const partitionedFonts = useMemo(() => {
    const mono: string[] = [];
    const prop: string[] = [];
    for (const font of fontOptions) {
      if (isMonospaceFont(font)) {
        mono.push(font);
      } else {
        prop.push(font);
      }
    }
    return { mono, prop };
  }, [fontOptions]);

  useEffect(() => {
    setFontSizeText(fontSize === null ? "" : String(fontSize));
  }, [fontSize]);

  const updateFontSize = (next: number) => {
    if (!Number.isFinite(next)) return;
    onChangeFontSize(Math.max(8, Math.min(32, Math.round(next))));
  };

  return (
    <div className="w-[380px] max-w-[calc(100vw-24px)] max-h-[min(420px,calc(100vh-24px))] overflow-hidden rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] shadow-lg">
      <ThemePreviewList
        value={themeValue}
        options={themeOptions}
        testId={themeListTestId}
        className="max-h-[min(270px,calc(100vh-170px))] overflow-y-auto overscroll-contain p-1"
        onChange={onChangeTheme}
      />
      <div className="border-t border-[var(--taomni-divider)] p-2 space-y-2">
        <label className="block">
          <span className="block mb-1 text-[11px] font-semibold text-[var(--taomni-text-muted)]">{labels.font}</span>
          <select
            className="taomni-input h-8 w-full text-[12px]"
            aria-label={labels.font}
            data-testid={fontSelectTestId}
            value={selectedFont}
            disabled={fontOptions.length === 0}
            onChange={(event) => onChangeFontFamily(makeTerminalFontFamily(event.target.value))}
          >
            {!fontFamily && (
              <option value={MIXED_FONT_VALUE} disabled>
                {labels.mixedFont}
              </option>
            )}
            {partitionedFonts.mono.length > 0 && (
              <optgroup label={labels.monospaceFonts}>
                {partitionedFonts.mono.map((font) => (
                  <option key={font} value={font}>
                    {font}
                  </option>
                ))}
              </optgroup>
            )}
            {partitionedFonts.prop.length > 0 && (
              <optgroup label={labels.proportionalFonts}>
                {partitionedFonts.prop.map((font) => (
                  <option key={font} value={font}>
                    {font}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold text-[var(--taomni-text-muted)]">{labels.textSize}</span>
          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              className="taomni-btn h-7 w-7 p-0 inline-flex items-center justify-center"
              aria-label={labels.decreaseTextSize}
              disabled={fontSize === null}
              onClick={() => fontSize !== null && updateFontSize(fontSize - 1)}
            >
              <Minus className="w-3.5 h-3.5" />
            </button>
            <input
              className="taomni-input h-7 w-14 text-center"
              aria-label={labels.fontSize}
              data-testid={fontSizeTestId}
              inputMode="numeric"
              placeholder={fontSize === null ? "-" : undefined}
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
                  setFontSizeText(fontSize === null ? "" : String(fontSize));
                  return;
                }
                const parsed = Number(fontSizeText);
                if (Number.isFinite(parsed) && parsed > 0) {
                  const clamped = Math.max(8, Math.min(32, Math.round(parsed)));
                  setFontSizeText(String(clamped));
                  onChangeFontSize(clamped);
                }
              }}
            />
            <button
              type="button"
              className="taomni-btn h-7 w-7 p-0 inline-flex items-center justify-center"
              aria-label={labels.increaseTextSize}
              disabled={fontSize === null}
              onClick={() => fontSize !== null && updateFontSize(fontSize + 1)}
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
