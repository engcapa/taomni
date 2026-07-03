import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Minus, Palette, Plus } from "lucide-react";
import {
  DEFAULT_MAIL_TERMINAL_PROFILE,
  isCustomTerminalTheme,
  makeCustomTerminalTheme,
  resolveTerminalTheme,
  type TerminalProfile,
} from "../../lib/terminalProfile";
import { normalizeMailThemeSelectValue, resolveMailTheme } from "../../lib/mailTheme";
import { useAppTheme } from "../../lib/appTheme";
import { useT } from "../../lib/i18n";
import { ThemePreviewSelect } from "../theme/ThemePreviewSelect";
import { buildMailThemeOptions } from "../theme/themePreviews";
import {
  isMonospaceFont,
  makeTerminalFontFamily,
  resolveSelectedFontName,
  useSystemFonts,
  useTerminalFontOptions,
} from "../../lib/systemFonts";

interface MailAppearanceSettingsProps {
  profile: TerminalProfile;
  onProfileChange: (profile: TerminalProfile) => void;
}

export function MailAppearanceSettings({
  profile,
  onProfileChange,
}: MailAppearanceSettingsProps) {
  const t = useT();
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
  const { resolvedTheme: resolvedAppTheme } = useAppTheme();
  const appPrefersDark = resolvedAppTheme === "dark";
  const resolvedTheme = resolveMailTheme(profile.theme, appPrefersDark);
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
  const themeOptions = useMemo(() => buildMailThemeOptions({
    systemLabel: t("mailAppearance.themeSystemName"),
    codeDarkGroup: t("mailAppearance.themeCodeDarkGroup"),
    codeLightGroup: t("mailAppearance.themeCodeLightGroup"),
    terminalGroup: t("mailAppearance.themeTerminalGroup"),
    customValue: customTheme ? profile.theme : undefined,
    customTheme,
    customLabel: t("mailAppearance.themeCustomName"),
  }), [customTheme, profile.theme, t]);

  const previewTheme = isCustomTerminalTheme(profile.theme)
    ? resolveMailTheme(makeCustomTerminalTheme(bg, fg), appPrefersDark)
    : resolvedTheme;
  const previewFontFamily = profile.fontFamily || DEFAULT_MAIL_TERMINAL_PROFILE.fontFamily;

  return (
    <div data-testid="mail-appearance-settings" className="space-y-4 text-[12px]">
      <section className="rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3">
        <div className="grid grid-cols-12 gap-3 items-end">
          <label className="col-span-12 md:col-span-8">
            <span className="block text-[12px] font-semibold mb-1">{t("mailAppearance.fontLabel")}</span>
            <select
              aria-label={t("mailAppearance.fontAria")}
              className="taomni-input w-full"
              value={selectedFont}
              disabled={fontOptions.length === 0}
              onChange={(event) => updateProfile({ fontFamily: makeTerminalFontFamily(event.target.value) })}
            >
              {partitionedFonts.mono.length > 0 && (
                <optgroup label={t("terminalAppearance.fontGroupMonoSystem")}>
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
          </label>

          <div className="col-span-12 md:col-span-4">
            <span className="block text-[12px] font-semibold mb-1">{t("mailAppearance.textSizeLabel")}</span>
            <div className="inline-flex items-center gap-1">
              <button
                className="taomni-btn h-8 w-8 p-0 inline-flex items-center justify-center"
                type="button"
                aria-label={t("mailAppearance.decreaseTextSize")}
                onClick={() => updateProfile({ fontSize: Math.max(8, profile.fontSize - 1) })}
              >
                <Minus className="w-4 h-4" />
              </button>
              <input
                className="taomni-input h-8 w-14 text-center"
                aria-label={t("mailAppearance.fontSizeAria")}
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
                aria-label={t("mailAppearance.increaseTextSize")}
                onClick={() => updateProfile({ fontSize: Math.min(32, profile.fontSize + 1) })}
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3">
        <div className="flex items-center gap-2 mb-2">
          <Palette className="w-3.5 h-3.5 text-[var(--taomni-accent)]" />
          <span className="font-semibold">{t("mailAppearance.themeHeading")}</span>
        </div>
        <ThemePreviewSelect
          ariaLabel={t("mailAppearance.themeSelectAria")}
          testId="mail-theme-select"
          value={normalizeMailThemeSelectValue(profile.theme)}
          options={themeOptions}
          onChange={(theme) => updateProfile({ theme })}
        />
      </section>

      <section className="rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3">
        <div className="grid grid-cols-12 gap-2 items-center">
          <label className="col-span-12 sm:col-span-6 flex items-center gap-2">
            <span className="w-24 text-[12px] font-semibold">{t("mailAppearance.backgroundLabel")}</span>
            <input
              type="color"
              value={isHexColor(bg) ? bg : "#000000"}
              onChange={(event) => updateCustomColor(event.target.value, fg)}
              aria-label={t("mailAppearance.backgroundColorAria")}
              className="w-8 h-7 border border-[#8aa0bd] rounded-sm"
            />
            <input
              className="taomni-input w-24 taomni-mono"
              value={bg}
              aria-label={t("mailAppearance.backgroundHexAria")}
              onChange={(event) => updateCustomColor(event.target.value, fg)}
            />
          </label>
          <label className="col-span-12 sm:col-span-6 flex items-center gap-2">
            <span className="w-24 text-[12px] font-semibold">{t("mailAppearance.foregroundLabel")}</span>
            <input
              type="color"
              value={isHexColor(fg) ? fg : "#ffffff"}
              onChange={(event) => updateCustomColor(bg, event.target.value)}
              aria-label={t("mailAppearance.foregroundColorAria")}
              className="w-8 h-7 border border-[#8aa0bd] rounded-sm"
            />
            <input
              className="taomni-input w-24 taomni-mono"
              value={fg}
              aria-label={t("mailAppearance.foregroundHexAria")}
              onChange={(event) => updateCustomColor(bg, event.target.value)}
            />
          </label>
        </div>
      </section>

      <MailMessagePreview theme={previewTheme} fontFamily={previewFontFamily} fontSize={profile.fontSize} />
    </div>
  );
}

function MailMessagePreview({
  theme,
  fontFamily,
  fontSize,
}: {
  theme: ReturnType<typeof resolveMailTheme>;
  fontFamily: string;
  fontSize: number;
}) {
  const bg = themeColor(theme.background, "#1d1f21");
  const fg = themeColor(theme.foreground, "#eaeaea");
  const accent = themeColor(theme.blue ?? theme.cyan ?? theme.cursor, "#83a7d8");
  const divider = mixColor(fg, bg, 18);
  const muted = mixColor(fg, bg, 62);
  const panel = mixColor(fg, bg, 7);
  const header = mixColor(fg, bg, 11);
  const selected = mixColor(accent, bg, 20);
  const style = {
    background: bg,
    color: fg,
    borderColor: divider,
    fontFamily,
    zoom: Math.max(8, Math.min(32, Math.round(fontSize))) / DEFAULT_MAIL_TERMINAL_PROFILE.fontSize,
  } satisfies CSSProperties;

  return (
    <section
      data-testid="mail-appearance-preview"
      className="rounded-md border overflow-hidden text-[12px]"
      style={style}
    >
      <div className="px-3 py-2 border-b" style={{ background: header, borderColor: divider }}>
        <div className="font-semibold truncate">{`Quarterly plan <review@example.com>`}</div>
        <div className="text-[11px] truncate" style={{ color: muted }}>
          Ada Lovelace to team@example.com
        </div>
      </div>
      <div className="grid grid-cols-[160px_minmax(0,1fr)] min-h-[132px]">
        <div className="border-r p-2 space-y-1.5" style={{ borderColor: divider, background: panel }}>
          <div className="rounded px-2 py-1.5" style={{ background: selected }}>
            <div className="font-semibold truncate">Quarterly plan</div>
            <div className="text-[11px] truncate" style={{ color: muted }}>Please review the attached brief.</div>
          </div>
          <div className="rounded px-2 py-1.5 opacity-80">
            <div className="font-semibold truncate">Release notes</div>
            <div className="text-[11px] truncate" style={{ color: muted }}>Draft is ready for edits.</div>
          </div>
        </div>
        <div className="p-3 leading-5">
          <div className="text-[15px] font-semibold mb-1">Hello team,</div>
          <p className="m-0 mb-2">
            Please review the <strong>planning brief</strong> before Friday and leave comments inline.
          </p>
          <ul className="m-0 mb-2 pl-5 list-disc">
            <li>Confirm milestones</li>
            <li>Update owners</li>
          </ul>
          <span className="font-semibold" style={{ color: accent }}>Open HTML brief</span>
        </div>
      </div>
    </section>
  );
}

function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

function themeColor(value: string | undefined, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function parseHexColor(value: string): [number, number, number] | null {
  const match = /^#([0-9a-fA-F]{6})$/.exec(value);
  if (!match) return null;
  const raw = match[1];
  return [
    parseInt(raw.slice(0, 2), 16),
    parseInt(raw.slice(2, 4), 16),
    parseInt(raw.slice(4, 6), 16),
  ];
}

function hex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
}

function mixColor(foreground: string, background: string, amount: number): string {
  const fg = parseHexColor(foreground);
  const bg = parseHexColor(background);
  if (!fg || !bg) return amount >= 50 ? foreground : background;
  const ratio = Math.max(0, Math.min(100, amount)) / 100;
  const mixed = fg.map((channel, index) => channel * ratio + bg[index] * (1 - ratio));
  return `#${hex(mixed[0])}${hex(mixed[1])}${hex(mixed[2])}`;
}
