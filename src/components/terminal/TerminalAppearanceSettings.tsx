import { Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { confirmAppDialog } from "../../lib/appDialogs";
import { useAppTheme } from "../../lib/appTheme";
import { useT } from "../../lib/i18n";
import { historyClear } from "../../lib/ipc";
import { getAppPlatform } from "../../lib/runtime";
import {
  getDefaultTerminalFontFamily,
  getPrimaryFontName,
  isMonospaceFont,
  makeTerminalFontFamily,
  resolveSelectedFontName,
  SAFE_TERMINAL_FONT_FALLBACKS,
  useSystemFonts,
  useTerminalFontOptions,
  type SystemFontState,
} from "../../lib/systemFonts";
import { isCustomTerminalTheme, makeCustomTerminalTheme, resolveSystemTerminalThemeId, resolveTerminalTheme, type TerminalProfile } from "../../lib/terminalProfile";
import { resolveThemeId } from "../../lib/themes";
import { ThemePreviewSelect } from "../theme/ThemePreviewSelect";
import { buildTerminalThemeOptions } from "../theme/themePreviews";
import { FontPickerSelect, type FontPickerOption } from "./FontPickerPanel";
import { CheckControl, CommonCommandsEditor } from "./appearance/controls";
import { type TerminalAppearanceSettingsProps } from "./appearance/model";
import { buildCursorOptions, buildRightClickOptions } from "./appearance/options";
import { isHexColor, TerminalPreview, themeColor } from "./appearance/preview";

export function TerminalAppearanceSettings(props: TerminalAppearanceSettingsProps) {
  if (props.fontState) {
    return <TerminalAppearanceSettingsContent {...props} fontState={props.fontState} />;
  }
  return <TerminalAppearanceSettingsWithFonts {...props} />;
}

function TerminalAppearanceSettingsWithFonts(props: TerminalAppearanceSettingsProps) {
  const [fontCatalogRequested, setFontCatalogRequested] = useState(false);
  const fontState = useSystemFonts(fontCatalogRequested);
  return (
    <TerminalAppearanceSettingsContent
      {...props}
      fontState={fontState}
      onRequestSystemFonts={() => setFontCatalogRequested(true)}
    />
  );
}

function TerminalAppearanceSettingsContent({
  profile,
  onProfileChange,
  showCustomColors = false,
  showPreview = true,
  allowSystemTheme = false,
  className = "",
  fontState,
  onRequestSystemFonts,
}: TerminalAppearanceSettingsProps & { fontState: SystemFontState; }) {
  const t = useT();
  const cursorOptions = useMemo(() => buildCursorOptions(t), [t]);
  const rightClickOptions = useMemo(() => buildRightClickOptions(t), [t]);
  const isWindows = getAppPlatform() === "windows";
  const primaryFont = useMemo(() => getPrimaryFontName(profile.fontFamily), [profile.fontFamily]);
  const fontOptions = useTerminalFontOptions(
    [...(fontState.fonts.length > 0 ? fontState.fonts : SAFE_TERMINAL_FONT_FALLBACKS), primaryFont],
  );
  const fontPickerOptions = useMemo<FontPickerOption[]>(() => fontOptions.map((font) => ({
    value: font,
    label: font,
    fontFamily: `"${font}", monospace`,
  })), [fontOptions]);
  const fontGroupLabels = useMemo(() => ({
    mono: t("terminalAppearance.fontGroupMonoRecommended"),
    proportional: t("terminalAppearance.fontGroupProportional"),
  }), [t]);
  const fontGroupForOption = useCallback(
    (option: FontPickerOption) => isMonospaceFont(option.label) ? "mono" : "proportional",
    [],
  );

  const selectedFont = resolveSelectedFontName(profile.fontFamily, fontOptions);

  const showFontWarning = useMemo(() => {
    return selectedFont ? !isMonospaceFont(selectedFont) : false;
  }, [selectedFont]);

  const safeFontFamily = useMemo(() => {
    return isMonospaceFont(primaryFont) ? profile.fontFamily : getDefaultTerminalFontFamily();
  }, [primaryFont, profile.fontFamily]);
  const { resolvedTheme: resolvedAppTheme } = useAppTheme();
  const appPrefersDark = resolvedAppTheme === "dark";
  const terminalSystemThemeSelected = allowSystemTheme && profile.theme === "system";
  const resolvedThemeId = terminalSystemThemeSelected ? resolveSystemTerminalThemeId(appPrefersDark) : profile.theme;
  const resolvedTheme = resolveTerminalTheme(resolvedThemeId);
  const colors = useMemo(
    () => ({
      background: themeColor(resolvedTheme.background, "#1d1f21"),
      foreground: themeColor(resolvedTheme.foreground, "#eaeaea"),
    }),
    [resolvedTheme],
  );
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
    setBg(colors.background);
    setFg(colors.foreground);
  }, [colors.background, colors.foreground]);

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

  const customTheme = isCustomTerminalTheme(profile.theme) ? resolveTerminalTheme(profile.theme) : null;
  const themeSelectValue = customTheme
    ? profile.theme
    : resolveThemeId(profile.theme);
  const themeOptions = useMemo(() => buildTerminalThemeOptions({
    includeSystem: allowSystemTheme,
    systemLabel: t("terminalAppearance.themeSystemName"),
    customValue: customTheme ? profile.theme : undefined,
    customTheme,
    customLabel: t("terminalAppearance.themeCustomName"),
    darkGroup: t("terminalAppearance.themeVariantDark"),
    lightGroup: t("terminalAppearance.themeVariantLight"),
  }), [allowSystemTheme, customTheme, profile.theme, t]);
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
            <FontPickerSelect
              ariaLabel={t("terminalAppearance.fontAria")}
              options={fontPickerOptions}
              selectedValue={selectedFont}
              loading={fontState.loading && fontState.fonts.length === 0}
              groupForOption={fontGroupForOption}
              groupLabels={fontGroupLabels}
              onOpen={onRequestSystemFonts}
              onSelect={(font) => updateProfile({ fontFamily: makeTerminalFontFamily(font) })}
            />
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
        <div className="block">
          <span className="block text-[12px] font-semibold mb-1">{t("terminalAppearance.themeHeading")}</span>
          <ThemePreviewSelect
            ariaLabel={t("terminalAppearance.themeSelectAria")}
            testId="terminal-theme-select"
            value={themeSelectValue}
            options={themeOptions}
            onChange={(theme) => updateProfile({ theme })}
          />
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
              testId="terminal-show-scrollbar-toggle"
              label={t("terminalAppearance.showScrollbar")}
              checked={profile.showScrollbar}
              onChange={(checked) => updateProfile({ showScrollbar: checked })}
            />
            {isWindows && (
              <CheckControl
                label={t("terminalAppearance.webglRenderer")}
                checked={profile.webglRenderer}
                onChange={(checked) => updateProfile({ webglRenderer: checked })}
              />
            )}
            <CheckControl
              testId="terminal-copy-on-select-toggle"
              label={t("terminalAppearance.copyOnSelect")}
              checked={profile.copyOnSelect}
              onChange={(checked) => updateProfile({ copyOnSelect: checked })}
            />
            <CheckControl
              testId="terminal-osc52-clipboard-toggle"
              label={t("terminalAppearance.allowOsc52")}
              checked={profile.allowRemoteOsc52Clipboard}
              onChange={(checked) => updateProfile({ allowRemoteOsc52Clipboard: checked })}
            />
            <CheckControl
              testId="terminal-read-only-toggle"
              label={t("terminalAppearance.readOnly")}
              checked={profile.readOnly}
              onChange={(checked) => updateProfile({ readOnly: checked })}
            />
            <CheckControl
              testId="terminal-bracketed-paste-toggle"
              label={t("terminalAppearance.bracketedPaste")}
              checked={profile.bracketedPaste}
              onChange={(checked) => updateProfile({ bracketedPaste: checked })}
            />
            <CheckControl
              testId="terminal-multiline-paste-confirm-toggle"
              label={t("terminalAppearance.multilinePasteConfirm")}
              checked={profile.multilinePasteConfirm}
              onChange={(checked) => updateProfile({ multilinePasteConfirm: checked })}
            />
            <CheckControl
              testId="terminal-keyword-highlighting-toggle"
              label={t("terminalAppearance.keywordHighlighting")}
              checked={profile.syntaxMode === "keywords"}
              onChange={(checked) => updateProfile({ syntaxMode: checked ? "keywords" : "default" })}
            />
            <CheckControl
              testId="terminal-save-scrollback-on-disconnect-toggle"
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
              testId="terminal-inline-suggestions-toggle"
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
                  { value: "history", label: t("terminalAppearance.suggestionSourceHistory"), desc: t("terminalAppearance.suggestionSourceHistoryDesc") },
                  { value: "history+path", label: t("terminalAppearance.suggestionSourceHistoryPath"), desc: t("terminalAppearance.suggestionSourceHistoryPathDesc") },
                  { value: "history+path+ai", label: t("terminalAppearance.suggestionSourceHistoryPathAi"), desc: t("terminalAppearance.suggestionSourceHistoryPathAiDesc") },
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
              testId="ai-command-rewrite-toggle"
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
              testId="terminal-ai-inline-qq-toggle"
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
