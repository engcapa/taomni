import { useEffect, useMemo, useState } from "react";
import { Check, Minus, Plus } from "lucide-react";
import {
  TERMINAL_THEME_DEFINITIONS,
  resolveThemeId,
  type TerminalThemeDefinition,
} from "../../lib/themes";
import {
  makeCustomTerminalTheme,
  resolveTerminalTheme,
  terminalProfileThemeColors,
  type TerminalProfile,
} from "../../lib/terminalProfile";
import {
  makeTerminalFontFamily,
  resolveSelectedFontName,
  useSystemFonts,
  useTerminalFontOptions,
} from "../../lib/systemFonts";

interface TerminalAppearanceSettingsProps {
  profile: TerminalProfile;
  onProfileChange: (profile: TerminalProfile) => void;
  showCustomColors?: boolean;
  showPreview?: boolean;
  className?: string;
}

export function TerminalAppearanceSettings({
  profile,
  onProfileChange,
  showCustomColors = false,
  showPreview = true,
  className = "",
}: TerminalAppearanceSettingsProps) {
  const fontState = useSystemFonts();
  const fontOptions = useTerminalFontOptions(fontState.fonts);
  const selectedFont = resolveSelectedFontName(profile.fontFamily, fontOptions);
  const colors = terminalProfileThemeColors(profile);
  const [bg, setBg] = useState(colors.background);
  const [fg, setFg] = useState(colors.foreground);
  const [fontSizeText, setFontSizeText] = useState(String(profile.fontSize));

  useEffect(() => {
    const nextColors = terminalProfileThemeColors(profile);
    setBg(nextColors.background);
    setFg(nextColors.foreground);
  }, [profile.theme]);

  useEffect(() => {
    setFontSizeText(String(profile.fontSize));
  }, [profile.fontSize]);

  const updateProfile = (patch: Partial<TerminalProfile>) => {
    onProfileChange({ ...profile, ...patch });
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

  return (
    <div data-testid="terminal-appearance-settings" className={`space-y-4 ${className}`}>
      <section className="rounded-md border border-[var(--moba-divider)] bg-white/70 p-3">
        <div className="grid grid-cols-12 gap-3 items-end">
          <label className="col-span-12 md:col-span-7">
            <span className="block text-[12px] font-semibold mb-1">Font</span>
            <select
              aria-label="Terminal font"
              className="moba-input w-full"
              value={selectedFont}
              disabled={fontOptions.length === 0}
              onChange={(event) => updateProfile({ fontFamily: makeTerminalFontFamily(event.target.value) })}
            >
              {fontOptions.map((font) => (
                <option key={font} value={font}>
                  {font}
                </option>
              ))}
            </select>
          </label>

          <div className="col-span-8 md:col-span-3">
            <span className="block text-[12px] font-semibold mb-1">Text Size</span>
            <div className="inline-flex items-center gap-1">
              <button
                className="moba-btn h-8 w-8 p-0 inline-flex items-center justify-center"
                type="button"
                aria-label="Decrease text size"
                onClick={() => updateProfile({ fontSize: Math.max(8, profile.fontSize - 1) })}
              >
                <Minus className="w-4 h-4" />
              </button>
              <input
                className="moba-input h-8 w-14 text-center"
                aria-label="Terminal font size"
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
                className="moba-btn h-8 w-8 p-0 inline-flex items-center justify-center"
                type="button"
                aria-label="Increase text size"
                onClick={() => updateProfile({ fontSize: Math.min(32, profile.fontSize + 1) })}
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>

          <label className="col-span-4 md:col-span-2 inline-flex items-center gap-1.5 pb-1">
            <input
              className="moba-checkbox"
              type="checkbox"
              aria-label="Enable font ligatures"
              checked={profile.fontLigatures}
              onChange={(event) => updateProfile({ fontLigatures: event.target.checked })}
            />
            <span className="text-[12px]">Ligatures</span>
          </label>
        </div>
      </section>

      <section className="rounded-md border border-[var(--moba-divider)] bg-white/70 p-3">
        <div className="text-[12px] font-semibold mb-2">Terminal theme</div>
        <div data-testid="terminal-theme-gallery" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
          {TERMINAL_THEME_DEFINITIONS.map((definition) => (
            <ThemeCard
              key={definition.id}
              definition={definition}
              selected={definition.id === selectedThemeId}
              onSelect={() => updateProfile({ theme: definition.id })}
            />
          ))}
        </div>
      </section>

      {showCustomColors && (
        <section className="rounded-md border border-[var(--moba-divider)] bg-white/70 p-3">
          <div className="grid grid-cols-12 gap-2 items-center">
            <label className="col-span-12 sm:col-span-6 flex items-center gap-2">
              <span className="w-24 text-[12px] font-semibold">Background</span>
              <input
                type="color"
                value={isHexColor(bg) ? bg : "#000000"}
                onChange={(event) => updateCustomColor(event.target.value, fg)}
                aria-label="Terminal background color"
                className="w-8 h-7 border border-[#8aa0bd] rounded-sm"
              />
              <input
                className="moba-input w-24 moba-mono"
                value={bg}
                aria-label="Terminal background hex"
                onChange={(event) => updateCustomColor(event.target.value, fg)}
              />
            </label>
            <label className="col-span-12 sm:col-span-6 flex items-center gap-2">
              <span className="w-24 text-[12px] font-semibold">Foreground</span>
              <input
                type="color"
                value={isHexColor(fg) ? fg : "#ffffff"}
                onChange={(event) => updateCustomColor(bg, event.target.value)}
                aria-label="Terminal foreground color"
                className="w-8 h-7 border border-[#8aa0bd] rounded-sm"
              />
              <input
                className="moba-input w-24 moba-mono"
                value={fg}
                aria-label="Terminal foreground hex"
                onChange={(event) => updateCustomColor(bg, event.target.value)}
              />
            </label>
          </div>
        </section>
      )}

      {showPreview && (
        <TerminalPreview
          background={showCustomColors ? bg : colors.background}
          foreground={showCustomColors ? fg : colors.foreground}
          fontFamily={profile.fontFamily}
          fontSize={profile.fontSize}
          theme={resolvedTheme}
        />
      )}
    </div>
  );
}

function ThemeCard({
  definition,
  selected,
  onSelect,
}: {
  definition: TerminalThemeDefinition;
  selected: boolean;
  onSelect: () => void;
}) {
  const theme = definition.theme;
  const borderColor = selected ? "var(--moba-accent)" : "var(--moba-divider)";

  return (
    <button
      type="button"
      aria-label={`Use theme ${definition.name}`}
      data-selected={selected}
      className="h-[74px] rounded-md border bg-white text-left p-2 flex items-center gap-2 hover:bg-[var(--moba-hover)]"
      style={{ borderColor }}
      onClick={onSelect}
    >
      <ThemeSwatch definition={definition} />
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-semibold truncate">{definition.name}</span>
        <span className="mt-1 flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: theme.green ?? "#62d36f" }} />
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: theme.blue ?? "#83a7d8" }} />
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: theme.yellow ?? "#e3a85e" }} />
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: theme.red ?? "#ff6b6b" }} />
        </span>
      </span>
      {selected && <Check className="w-4 h-4 text-[var(--moba-accent)] flex-shrink-0" />}
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
      className="w-[68px] h-[46px] rounded border p-1 flex-shrink-0"
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
  theme,
}: {
  background: string;
  foreground: string;
  fontFamily: string;
  fontSize: number;
  theme: ReturnType<typeof resolveTerminalTheme>;
}) {
  return (
    <div
      data-testid="terminal-preview"
      className="rounded-md p-3 moba-mono leading-relaxed border border-black/10"
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
      <span className="moba-blink">▌</span>
    </div>
  );
}

function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}
