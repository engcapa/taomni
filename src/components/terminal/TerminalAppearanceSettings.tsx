import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Minus, Plus, Trash2 } from "lucide-react";
import {
  TERMINAL_THEME_DEFINITIONS,
  resolveThemeId,
  type TerminalThemeDefinition,
} from "../../lib/themes";
import {
  makeCustomTerminalTheme,
  resolveTerminalTheme,
  terminalProfileThemeColors,
  type TerminalCursorStyle,
  type TerminalProfile,
  type TerminalRightClickBehavior,
  type UserCommonCommand,
} from "../../lib/terminalProfile";
import {
  getPrimaryFontName,
  isMonospaceFont,
  makeTerminalFontFamily,
  resolveSelectedFontName,
  useSystemFonts,
  useTerminalFontOptions,
} from "../../lib/systemFonts";
import { historyClear } from "../../lib/ipc";
import { useT, type TranslateFn } from "../../lib/i18n";
import { confirmAppDialog } from "../../lib/appDialogs";

interface TerminalAppearanceSettingsProps {
  profile: TerminalProfile;
  onProfileChange: (profile: TerminalProfile) => void;
  showCustomColors?: boolean;
  showPreview?: boolean;
  className?: string;
}

function buildCursorOptions(t: TranslateFn): Array<{ label: string; style: TerminalCursorStyle; blink: boolean }> {
  return [
    { label: t("terminalAppearance.cursorBlockBlink"), style: "block", blink: true },
    { label: t("terminalAppearance.cursorBlockSteady"), style: "block", blink: false },
    { label: t("terminalAppearance.cursorUnderlineBlink"), style: "underline", blink: true },
    { label: t("terminalAppearance.cursorUnderlineSteady"), style: "underline", blink: false },
    { label: t("terminalAppearance.cursorBarBlink"), style: "bar", blink: true },
    { label: t("terminalAppearance.cursorBarSteady"), style: "bar", blink: false },
  ];
}

function buildRightClickOptions(t: TranslateFn): Array<{ label: string; value: TerminalRightClickBehavior }> {
  return [
    { label: t("terminalAppearance.rightClickContextMenu"), value: "menu" },
    { label: t("terminalAppearance.rightClickPaste"), value: "paste" },
    { label: t("terminalAppearance.rightClickCopyOrPaste"), value: "copy-or-paste" },
  ];
}

export function TerminalAppearanceSettings({
  profile,
  onProfileChange,
  showCustomColors = false,
  showPreview = true,
  className = "",
}: TerminalAppearanceSettingsProps) {
  const t = useT();
  const cursorOptions = useMemo(() => buildCursorOptions(t), [t]);
  const rightClickOptions = useMemo(() => buildRightClickOptions(t), [t]);
  const fontState = useSystemFonts();
  const fontOptions = useTerminalFontOptions(fontState.fonts);
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

  const selectedFont = resolveSelectedFontName(profile.fontFamily, fontOptions);

  const showFontWarning = useMemo(() => {
    return selectedFont ? !isMonospaceFont(selectedFont) : false;
  }, [selectedFont]);

  const primaryFont = useMemo(() => getPrimaryFontName(profile.fontFamily), [profile.fontFamily]);
  const safeFontFamily = useMemo(() => {
    return isMonospaceFont(primaryFont) ? profile.fontFamily : makeTerminalFontFamily("Source Code Pro");
  }, [primaryFont, profile.fontFamily]);
  const colors = terminalProfileThemeColors(profile);
  const [bg, setBg] = useState(colors.background);
  const [fg, setFg] = useState(colors.foreground);
  const [fontSizeText, setFontSizeText] = useState(String(profile.fontSize));
  const [scrollbackText, setScrollbackText] = useState(String(profile.scrollback));
  const [inlineSuggestionsMaxText, setInlineSuggestionsMaxText] = useState(
    String(profile.inlineSuggestionsMax),
  );
  const [clearingHistory, setClearingHistory] = useState(false);
  const draftProfileRef = useRef(profile);

  useEffect(() => {
    draftProfileRef.current = profile;
  }, [profile]);

  useEffect(() => {
    const nextColors = terminalProfileThemeColors(profile);
    setBg(nextColors.background);
    setFg(nextColors.foreground);
  }, [profile.theme]);

  useEffect(() => {
    setFontSizeText(String(profile.fontSize));
  }, [profile.fontSize]);

  useEffect(() => {
    setScrollbackText(String(profile.scrollback));
  }, [profile.scrollback]);

  useEffect(() => {
    setInlineSuggestionsMaxText(String(profile.inlineSuggestionsMax));
  }, [profile.inlineSuggestionsMax]);

  const updateProfile = (patch: Partial<TerminalProfile>) => {
    const next = { ...draftProfileRef.current, ...patch };
    draftProfileRef.current = next;
    onProfileChange(next);
  };

  const updateCustomColor = (nextBg: string, nextFg: string) => {
    setBg(nextBg);
    setFg(nextFg);
    if (isHexColor(nextBg) && isHexColor(nextFg)) {
      updateProfile({ theme: makeCustomTerminalTheme(nextBg, nextFg) });
    }
  };

  const resolvedTheme = resolveTerminalTheme(profile.theme);
  const selectedThemeId = resolveThemeId(profile.theme);
  const selectedCursor = cursorOptions.find((option) =>
    option.style === profile.cursorStyle && option.blink === profile.cursorBlink
  )?.label ?? cursorOptions[0].label;
  const selectedRightClick = rightClickOptions.find((option) =>
    option.value === profile.rightClickBehavior
  )?.label ?? rightClickOptions[0].label;

  return (
    <div data-testid="terminal-appearance-settings" className={`space-y-4 ${className}`}>
      <section className="rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3">
        <div className="grid grid-cols-12 gap-3 items-end">
          <label className="col-span-12 md:col-span-7">
            <span className="block text-[12px] font-semibold mb-1">{t("terminalAppearance.fontLabel")}</span>
            <select
              aria-label={t("terminalAppearance.fontAria")}
              className="taomni-input w-full"
              value={selectedFont}
              disabled={fontOptions.length === 0}
              onChange={(event) => updateProfile({ fontFamily: makeTerminalFontFamily(event.target.value) })}
            >
              {partitionedFonts.mono.length > 0 && (
                <optgroup label={t("terminalAppearance.fontGroupMonoRecommended")}>
                  {partitionedFonts.mono.map((font) => (
                    <option key={font} value={font}>
                      {font}
                    </option>
                  ))}
                </optgroup>
              )}
              {partitionedFonts.prop.length > 0 && (
                <optgroup label={t("terminalAppearance.fontGroupProportional")}>
                  {partitionedFonts.prop.map((font) => (
                    <option key={font} value={font}>
                      {font}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            {showFontWarning && (
              <p className="mt-1.5 text-[11px] text-[#ff6b6b] leading-snug">
                ⚠️ {t("terminalAppearance.nonMonospaceWarning")}
              </p>
            )}
          </label>

          <div className="col-span-8 md:col-span-3">
            <span className="block text-[12px] font-semibold mb-1">{t("terminalAppearance.textSizeLabel")}</span>
            <div className="inline-flex items-center gap-1">
              <button
                className="taomni-btn h-8 w-8 p-0 inline-flex items-center justify-center"
                type="button"
                aria-label={t("terminalAppearance.decreaseTextSize")}
                onClick={() => updateProfile({ fontSize: Math.max(8, profile.fontSize - 1) })}
              >
                <Minus className="w-4 h-4" />
              </button>
              <input
                className="taomni-input h-8 w-14 text-center"
                aria-label={t("terminalAppearance.fontSizeAria")}
                value={fontSizeText}
                inputMode="numeric"
                onChange={(event) => {
                  const next = event.target.value;
                  if (!/^\d*$/.test(next)) return;
                  setFontSizeText(next);
                  const parsed = Number(next);
                  if (Number.isFinite(parsed) && parsed >= 8 && parsed <= 32) {
                    updateProfile({ fontSize: Math.round(parsed) });
                  }
                }}
                onBlur={() => {
                  const parsed = Number(fontSizeText);
                  if (Number.isFinite(parsed) && parsed > 0) {
                    const clamped = Math.max(8, Math.min(32, Math.round(parsed)));
                    setFontSizeText(String(clamped));
                    updateProfile({ fontSize: clamped });
                  } else {
                    setFontSizeText(String(profile.fontSize));
                  }
                }}
              />
              <button
                className="taomni-btn h-8 w-8 p-0 inline-flex items-center justify-center"
                type="button"
                aria-label={t("terminalAppearance.increaseTextSize")}
                onClick={() => updateProfile({ fontSize: Math.min(32, profile.fontSize + 1) })}
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>

          <label className="col-span-4 md:col-span-2 inline-flex items-center gap-1.5 pb-1">
            <input
              className="taomni-checkbox"
              type="checkbox"
              aria-label={t("terminalAppearance.enableLigaturesAria")}
              checked={profile.fontLigatures}
              onChange={(event) => updateProfile({ fontLigatures: event.target.checked })}
            />
            <span className="text-[12px]">{t("terminalAppearance.ligaturesLabel")}</span>
          </label>
        </div>
      </section>

      <section className="rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3">
        <div className="text-[12px] font-semibold mb-2">{t("terminalAppearance.themeHeading")}</div>
        <div className="max-h-[300px] overflow-auto rounded-md pr-0.5">
          <ul data-testid="terminal-theme-gallery" className="flex flex-col gap-1.5">
            {TERMINAL_THEME_DEFINITIONS.map((definition) => (
              <li key={definition.id}>
                <ThemeCard
                  definition={definition}
                  selected={definition.id === selectedThemeId}
                  onSelect={() => updateProfile({ theme: definition.id })}
                  t={t}
                />
              </li>
            ))}
          </ul>
        </div>
      </section>

      {showCustomColors && (
        <section className="rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3">
          <div className="grid grid-cols-12 gap-2 items-center">
            <label className="col-span-12 sm:col-span-6 flex items-center gap-2">
              <span className="w-24 text-[12px] font-semibold">{t("terminalAppearance.customBackgroundLabel")}</span>
              <input
                type="color"
                value={isHexColor(bg) ? bg : "#000000"}
                onChange={(event) => updateCustomColor(event.target.value, fg)}
                aria-label={t("terminalAppearance.backgroundColorAria")}
                className="w-8 h-7 border border-[#8aa0bd] rounded-sm"
              />
              <input
                className="taomni-input w-24 taomni-mono"
                value={bg}
                aria-label={t("terminalAppearance.backgroundHexAria")}
                onChange={(event) => updateCustomColor(event.target.value, fg)}
              />
            </label>
            <label className="col-span-12 sm:col-span-6 flex items-center gap-2">
              <span className="w-24 text-[12px] font-semibold">{t("terminalAppearance.customForegroundLabel")}</span>
              <input
                type="color"
                value={isHexColor(fg) ? fg : "#ffffff"}
                onChange={(event) => updateCustomColor(bg, event.target.value)}
                aria-label={t("terminalAppearance.foregroundColorAria")}
                className="w-8 h-7 border border-[#8aa0bd] rounded-sm"
              />
              <input
                className="taomni-input w-24 taomni-mono"
                value={fg}
                aria-label={t("terminalAppearance.foregroundHexAria")}
                onChange={(event) => updateCustomColor(bg, event.target.value)}
              />
            </label>
          </div>
        </section>
      )}

      <section className="rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3">
        <div className="text-[12px] font-semibold mb-2">{t("terminalAppearance.behaviorHeading")}</div>
        <div className="grid grid-cols-12 gap-x-3 gap-y-3 text-[12px]">
          <label className="col-span-12 md:col-span-4">
            <span className="block mb-1 text-[var(--taomni-text-muted)]">{t("terminalAppearance.cursorLabel")}</span>
            <select
              aria-label={t("terminalAppearance.cursorAria")}
              className="taomni-input w-full"
              value={selectedCursor}
              onChange={(event) => {
                const option = cursorOptions.find((item) => item.label === event.target.value);
                if (option) updateProfile({ cursorStyle: option.style, cursorBlink: option.blink });
              }}
            >
              {cursorOptions.map((option) => (
                <option key={option.label}>{option.label}</option>
              ))}
            </select>
          </label>

          <label className="col-span-12 md:col-span-4">
            <span className="block mb-1 text-[var(--taomni-text-muted)]">{t("terminalAppearance.scrollbackLabel")}</span>
            <span className="flex items-center gap-2">
              <input
                className="taomni-input w-28"
                value={scrollbackText}
                aria-label={t("terminalAppearance.scrollbackLinesAria")}
                inputMode="numeric"
                onChange={(event) => {
                  const next = event.target.value;
                  if (!/^\d*$/.test(next)) return;
                  setScrollbackText(next);
                  const parsed = Number(next);
                  if (Number.isFinite(parsed) && parsed >= 100 && parsed <= 200000) {
                    updateProfile({ scrollback: Math.round(parsed) });
                  }
                }}
                onBlur={() => {
                  const parsed = Number(scrollbackText);
                  if (Number.isFinite(parsed) && parsed > 0) {
                    const clamped = Math.max(100, Math.min(200000, Math.round(parsed)));
                    setScrollbackText(String(clamped));
                    updateProfile({ scrollback: clamped });
                  } else {
                    setScrollbackText(String(profile.scrollback));
                  }
                }}
              />
              <span className="text-[var(--taomni-text-muted)]">{t("terminalAppearance.scrollbackLinesSuffix")}</span>
            </span>
          </label>

          <label className="col-span-12 md:col-span-4">
            <span className="block mb-1 text-[var(--taomni-text-muted)]">{t("terminalAppearance.rightClickLabel")}</span>
            <select
              aria-label={t("terminalAppearance.rightClickAria")}
              className="taomni-input w-full"
              value={selectedRightClick}
              onChange={(event) => {
                const option = rightClickOptions.find((item) => item.label === event.target.value);
                if (option) updateProfile({ rightClickBehavior: option.value });
              }}
            >
              {rightClickOptions.map((option) => (
                <option key={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          <div className="col-span-12 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
            <CheckControl
              label={t("terminalAppearance.showScrollbar")}
              checked={profile.showScrollbar}
              onChange={(checked) => updateProfile({ showScrollbar: checked })}
            />
            <CheckControl
              label={t("terminalAppearance.copyOnSelect")}
              checked={profile.copyOnSelect}
              onChange={(checked) => updateProfile({ copyOnSelect: checked })}
            />
            <CheckControl
              label={t("terminalAppearance.allowOsc52")}
              checked={profile.allowRemoteOsc52Clipboard}
              onChange={(checked) => updateProfile({ allowRemoteOsc52Clipboard: checked })}
            />
            <CheckControl
              label={t("terminalAppearance.readOnly")}
              checked={profile.readOnly}
              onChange={(checked) => updateProfile({ readOnly: checked })}
            />
            <CheckControl
              label={t("terminalAppearance.bracketedPaste")}
              checked={profile.bracketedPaste}
              onChange={(checked) => updateProfile({ bracketedPaste: checked })}
            />
            <CheckControl
              label={t("terminalAppearance.multilinePasteConfirm")}
              checked={profile.multilinePasteConfirm}
              onChange={(checked) => updateProfile({ multilinePasteConfirm: checked })}
            />
            <CheckControl
              label={t("terminalAppearance.keywordHighlighting")}
              checked={profile.syntaxMode === "keywords"}
              onChange={(checked) => updateProfile({ syntaxMode: checked ? "keywords" : "default" })}
            />
            <CheckControl
              label={t("terminalAppearance.saveScrollbackOnDisconnect")}
              checked={profile.loggingEnabled}
              onChange={(checked) => updateProfile({ loggingEnabled: checked })}
            />
          </div>
        </div>
      </section>

      {showPreview && (
        <TerminalPreview
          background={showCustomColors ? bg : colors.background}
          foreground={showCustomColors ? fg : colors.foreground}
          fontFamily={safeFontFamily}
          fontSize={profile.fontSize}
          cursorStyle={profile.cursorStyle}
          cursorBlink={profile.cursorBlink}
          theme={resolvedTheme}
        />
      )}

      <section className="rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3">
        <div className="text-[12px] font-semibold mb-2">{t("terminalAppearance.inlineSuggestionsHeading")}</div>
        <div className="grid grid-cols-12 gap-x-3 gap-y-3 text-[12px] items-end">
          <div className="col-span-12 md:col-span-7">
            <CheckControl
              label={t("terminalAppearance.inlineSuggestionsToggle")}
              checked={profile.inlineSuggestions}
              onChange={(checked) => updateProfile({ inlineSuggestions: checked })}
            />
            <p className="mt-1 text-[11px] text-[var(--taomni-text-muted)] leading-snug">
              {t("terminalAppearance.inlineSuggestionsHint")}
            </p>
          </div>

          <label className="col-span-8 md:col-span-3">
            <span className="block mb-1 text-[var(--taomni-text-muted)]">{t("terminalAppearance.inlineSuggestionsMaxLabel")}</span>
            <input
              className="taomni-input w-28"
              value={inlineSuggestionsMaxText}
              aria-label={t("terminalAppearance.inlineSuggestionsMaxAria")}
              inputMode="numeric"
              disabled={!profile.inlineSuggestions}
              onChange={(event) => {
                const next = event.target.value;
                if (!/^\d*$/.test(next)) return;
                setInlineSuggestionsMaxText(next);
                const parsed = Number(next);
                if (Number.isFinite(parsed) && parsed >= 100 && parsed <= 50000) {
                  updateProfile({ inlineSuggestionsMax: Math.round(parsed) });
                }
              }}
              onBlur={() => {
                const parsed = Number(inlineSuggestionsMaxText);
                if (Number.isFinite(parsed) && parsed > 0) {
                  const clamped = Math.max(100, Math.min(50000, Math.round(parsed)));
                  setInlineSuggestionsMaxText(String(clamped));
                  updateProfile({ inlineSuggestionsMax: clamped });
                } else {
                  setInlineSuggestionsMaxText(String(profile.inlineSuggestionsMax));
                }
              }}
            />
          </label>

          <div className="col-span-12 md:col-span-2 flex md:justify-end">
            <button
              type="button"
              className="taomni-btn h-8 px-2 text-[11px]"
              disabled={clearingHistory}
              onClick={async () => {
                const confirmed = await confirmAppDialog({
                  message: t("terminalAppearance.clearAllHistoryConfirm"),
                  confirmLabel: t("common.delete"),
                  danger: true,
                });
                if (!confirmed) {
                  return;
                }
                setClearingHistory(true);
                historyClear(null)
                  .catch((err) => {
                    console.error("Failed to clear history", err);
                  })
                  .finally(() => setClearingHistory(false));
              }}
            >
              {t("terminalAppearance.clearAllHistory")}
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3">
        <div className="text-[12px] font-semibold mb-2">{t("terminalAppearance.aiAssistanceHeading")}</div>
        <div className="space-y-3">
          <div>
            <div className="text-[11px] text-[var(--taomni-text-muted)] mb-1.5">{t("terminalAppearance.suggestionSourceLabel")}</div>
            <div className="flex flex-col gap-1.5">
              {(
                [
                  { value: "history",          label: t("terminalAppearance.suggestionSourceHistory"),         desc: t("terminalAppearance.suggestionSourceHistoryDesc") },
                  { value: "history+path",     label: t("terminalAppearance.suggestionSourceHistoryPath"),     desc: t("terminalAppearance.suggestionSourceHistoryPathDesc") },
                  { value: "history+path+ai",  label: t("terminalAppearance.suggestionSourceHistoryPathAi"),   desc: t("terminalAppearance.suggestionSourceHistoryPathAiDesc") },
                ] as const
              ).map(({ value, label, desc }) => (
                <label key={value} className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="inlineSuggestionsSource"
                    value={value}
                    checked={profile.inlineSuggestionsSource === value}
                    disabled={!profile.inlineSuggestions}
                    onChange={() => updateProfile({ inlineSuggestionsSource: value })}
                    className="mt-0.5 accent-[var(--taomni-accent)]"
                  />
                  <div>
                    <div className="text-[12px]">{label}</div>
                    <div className="text-[11px] text-[var(--taomni-text-muted)]">{desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="pt-2 border-t border-[var(--taomni-divider)]">
            <CheckControl
              label={t("terminalAppearance.enableAiRewrite")}
              checked={profile.aiCommandRewriteEnabled}
              onChange={(checked) => updateProfile({ aiCommandRewriteEnabled: checked })}
            />
            <p className="mt-1 text-[11px] text-[var(--taomni-text-muted)] leading-snug">
              {t("terminalAppearance.enableAiRewriteHint")}
            </p>
            <label className="mt-2 flex items-center gap-2 text-[11px]">
              <span className="text-[var(--taomni-text-muted)]">{t("terminalAppearance.aiRewriteShortcutLabel")}</span>
              <input
                className="taomni-input h-7 w-32 text-[12px]"
                value={profile.aiCommandRewriteShortcut}
                aria-label={t("terminalAppearance.aiRewriteShortcutAria")}
                disabled={!profile.aiCommandRewriteEnabled}
                onChange={(event) =>
                  updateProfile({ aiCommandRewriteShortcut: event.target.value })
                }
                placeholder="Ctrl+K"
              />
            </label>
          </div>

          <div className="pt-2 border-t border-[var(--taomni-divider)]">
            <CheckControl
              label={t("terminalAppearance.aiInlineQqLabel")}
              checked={profile.aiInlineQqRender}
              onChange={(checked) => updateProfile({ aiInlineQqRender: checked })}
            />
            <p className="mt-1 text-[11px] text-[var(--taomni-text-muted)] leading-snug">
              {t("terminalAppearance.aiInlineQqHint")}
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3">
        <div className="text-[12px] font-semibold mb-2">{t("terminalAppearance.commonCommandsHeading")}</div>
        <p className="text-[11px] text-[var(--taomni-text-muted)] leading-snug mb-2">
          {t("terminalAppearance.commonCommandsHint")}
        </p>
        <CommonCommandsEditor
          value={profile.commonCommands}
          onChange={(next) => updateProfile({ commonCommands: next })}
          t={t}
        />
      </section>

    </div>
  );
}

function CheckControl({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="inline-flex items-center gap-1.5">
      <input
        className="taomni-checkbox"
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function ThemeCard({
  definition,
  selected,
  onSelect,
  t,
}: {
  definition: TerminalThemeDefinition;
  selected: boolean;
  onSelect: () => void;
  t: TranslateFn;
}) {
  const theme = definition.theme;
  const borderColor = selected ? "var(--taomni-accent)" : "var(--taomni-divider)";

  return (
    <button
      type="button"
      aria-label={t("terminalAppearance.themeUseLabel", { name: definition.name })}
      data-selected={selected}
      className="w-full rounded-md border bg-[var(--taomni-card-bg)] text-left px-2.5 py-1.5 flex items-center gap-3 hover:bg-[var(--taomni-hover)]"
      style={{ borderColor }}
      onClick={onSelect}
    >
      <ThemeSwatch definition={definition} />
      <span className="min-w-0 flex-1 flex items-center gap-2">
        <span className="text-[12px] font-semibold truncate">{definition.name}</span>
        <span className="flex-shrink-0 rounded-sm border border-[var(--taomni-divider)] px-1 py-px text-[10px] leading-none text-[var(--taomni-text-muted)]">
          {definition.variant === "light"
            ? t("terminalAppearance.themeVariantLight")
            : t("terminalAppearance.themeVariantDark")}
        </span>
      </span>
      <span className="flex flex-shrink-0 items-center gap-1.5">
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: theme.green ?? "#62d36f" }} />
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: theme.blue ?? "#83a7d8" }} />
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: theme.yellow ?? "#e3a85e" }} />
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: theme.red ?? "#ff6b6b" }} />
      </span>
      {selected ? (
        <Check className="w-4 h-4 text-[var(--taomni-accent)] flex-shrink-0" />
      ) : (
        <span className="w-4 flex-shrink-0" aria-hidden="true" />
      )}
    </button>
  );
}

function ThemeSwatch({ definition }: { definition: TerminalThemeDefinition }) {
  const theme = definition.theme;
  const line = useMemo(
    () => [
      theme.green ?? "#62d36f",
      theme.cyan ?? "#89ddff",
      theme.blue ?? "#83a7d8",
      theme.yellow ?? "#e3a85e",
    ],
    [theme.blue, theme.cyan, theme.green, theme.yellow],
  );

  return (
    <span
      className="w-[58px] h-[40px] rounded border p-1 flex-shrink-0"
      style={{
        background: theme.background ?? "#1d1f21",
        color: theme.foreground ?? "#eaeaea",
        borderColor: definition.variant === "light" ? "#c9d1dc" : "#455062",
      }}
    >
      <span className="block h-1.5 rounded-sm mb-1" style={{ background: line[0] }} />
      <span className="flex gap-1 mb-1">
        <span className="block h-1.5 w-7 rounded-sm" style={{ background: line[1] }} />
        <span className="block h-1.5 w-5 rounded-sm" style={{ background: line[2] }} />
      </span>
      <span className="flex gap-1 mb-1">
        <span className="block h-1.5 w-4 rounded-sm" style={{ background: line[0] }} />
        <span className="block h-1.5 w-4 rounded-sm" style={{ background: line[3] }} />
        <span className="block h-1.5 w-3 rounded-sm" style={{ background: theme.foreground ?? "#eaeaea" }} />
      </span>
      <span className="flex gap-1">
        <span className="block h-1.5 w-5 rounded-sm" style={{ background: theme.foreground ?? "#eaeaea", opacity: 0.75 }} />
        <span className="block h-1.5 w-3 rounded-sm" style={{ background: line[2] }} />
      </span>
    </span>
  );
}

function TerminalPreview({
  background,
  foreground,
  fontFamily,
  fontSize,
  cursorStyle,
  cursorBlink,
  theme,
}: {
  background: string;
  foreground: string;
  fontFamily: string;
  fontSize: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  theme: ReturnType<typeof resolveTerminalTheme>;
}) {
  const cursorColor = theme.cursor ?? foreground;

  return (
    <div
      data-testid="terminal-preview"
      className="rounded-md p-3 taomni-mono leading-relaxed border border-black/10"
      style={{ background, color: foreground, fontFamily, fontSize }}
    >
      <span style={{ color: theme.green ?? "#62d36f" }}>user@host</span>
      <span style={{ color: "#bbbbbb" }}>:</span>
      <span style={{ color: theme.blue ?? "#83a7d8" }}>~/srv</span>
      {"$ tail -f /var/log/nginx/error.log"}
      <br />
      <span style={{ color: theme.yellow ?? "#e3a85e" }}>warning</span>
      {": 2 worker connections are not enough"}
      <br />
      <span style={{ color: theme.red ?? "#ff6b6b" }}>error</span>
      {": connect() failed (111: Connection refused)"}
      <br />
      <TerminalPreviewCursor
        color={cursorColor}
        foreground={foreground}
        styleName={cursorStyle}
        blink={cursorBlink}
      />
    </div>
  );
}

function TerminalPreviewCursor({
  color,
  foreground,
  styleName,
  blink,
}: {
  color: string;
  foreground: string;
  styleName: TerminalCursorStyle;
  blink: boolean;
}) {
  const className = blink ? "taomni-blink" : "";

  if (styleName === "underline") {
    return (
      <span
        data-testid="terminal-preview-cursor"
        className={`inline-block w-[0.65em] h-[1em] align-[-0.1em] ${className}`}
        style={{ borderBottom: `2px solid ${color}` }}
      />
    );
  }

  if (styleName === "bar") {
    return (
      <span
        data-testid="terminal-preview-cursor"
        className={`inline-block w-[0.4em] h-[1em] align-[-0.1em] ${className}`}
        style={{ borderLeft: `2px solid ${color}` }}
      />
    );
  }

  return (
    <span
      data-testid="terminal-preview-cursor"
      className={`inline-block w-[0.65em] h-[1em] align-[-0.1em] ${className}`}
      style={{ background: color, color: foreground }}
    />
  );
}

function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

interface CommonCommandsEditorProps {
  value: UserCommonCommand[];
  onChange: (next: UserCommonCommand[]) => void;
  t: TranslateFn;
}

function CommonCommandsEditor({ value, onChange, t }: CommonCommandsEditorProps) {
  const updateRow = (index: number, patch: Partial<UserCommonCommand>) => {
    const next = value.slice();
    const current = next[index] ?? { command: "" };
    next[index] = { ...current, ...patch };
    onChange(next);
  };
  const removeRow = (index: number) => {
    const next = value.slice();
    next.splice(index, 1);
    onChange(next);
  };
  const addRow = () => {
    onChange([...value, { command: "" }]);
  };

  return (
    <div className="flex flex-col gap-1.5">
      {value.length === 0 ? (
        <div className="text-[11px] text-[var(--taomni-text-muted)] italic px-1 py-2">
          {t("terminalAppearance.commonCommandsEmpty")}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {value.map((item, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <input
                className="taomni-input flex-1 min-w-0 font-mono text-[12px]"
                placeholder={t("terminalAppearance.commonCommandPlaceholder")}
                value={item.command}
                onChange={(e) => updateRow(idx, { command: e.target.value })}
                aria-label={t("terminalAppearance.commonCommandAriaCommand", { index: idx + 1 })}
              />
              <input
                className="taomni-input flex-1 min-w-0 text-[12px]"
                placeholder={t("terminalAppearance.commonCommandDescriptionPlaceholder")}
                value={item.description ?? ""}
                onChange={(e) => updateRow(idx, { description: e.target.value })}
                aria-label={t("terminalAppearance.commonCommandAriaDescription", { index: idx + 1 })}
              />
              <button
                type="button"
                className="taomni-btn h-8 w-8 p-0 inline-flex items-center justify-center"
                onClick={() => removeRow(idx)}
                aria-label={t("terminalAppearance.commonCommandRemoveAria", { index: idx + 1 })}
                title={t("terminalAppearance.commonCommandRemove")}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        className="taomni-btn h-8 px-2 text-[11px] self-start inline-flex items-center gap-1"
        onClick={addRow}
      >
        <Plus size={12} /> {t("terminalAppearance.commonCommandAddEntry")}
      </button>
    </div>
  );
}
