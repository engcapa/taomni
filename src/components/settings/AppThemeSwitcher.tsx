import { Monitor, Moon, Sun } from "lucide-react";
import { useAppTheme, type AppThemeMode } from "../../lib/appTheme";
import { useT } from "../../lib/i18n";
import { useAppThemeI18nLabel } from "../../lib/i18n/labels";

const THEME_MODES: Array<{ mode: AppThemeMode; icon: React.ReactNode }> = [
  { mode: "light", icon: <Sun className="w-4 h-4" /> },
  { mode: "dark", icon: <Moon className="w-4 h-4" /> },
  { mode: "system", icon: <Monitor className="w-4 h-4" /> },
];

export function AppThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const { mode, resolvedTheme, setMode } = useAppTheme();
  const t = useT();
  const themeLabel = useAppThemeI18nLabel();

  if (compact) {
    return (
      <label className="inline-flex items-center gap-1.5 text-[11px]">
        <span className="text-[var(--taomni-text-muted)]">{t("settings.themeLabel")}</span>
        <select
          className="taomni-input h-6 w-[122px]"
          aria-label={t("titlebar.appThemeAria")}
          value={mode}
          title={t("settings.appThemeCurrent", { mode: themeLabel(mode), resolved: resolvedTheme })}
          onChange={(event) => setMode(event.target.value as AppThemeMode)}
        >
          {THEME_MODES.map((item) => (
            <option key={item.mode} value={item.mode}>
              {themeLabel(item.mode)}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <div className="inline-flex rounded-md border border-[var(--taomni-input-border)] overflow-hidden">
      {THEME_MODES.map((item) => (
        <ThemeModeButton
          key={item.mode}
          mode={item.mode}
          currentMode={mode}
          onSelect={setMode}
          icon={item.icon}
        />
      ))}
    </div>
  );
}

export function AppThemeIconButton() {
  const { mode, resolvedTheme, setMode } = useAppTheme();
  const t = useT();
  const themeLabel = useAppThemeI18nLabel();
  const currentIndex = THEME_MODES.findIndex((item) => item.mode === mode);
  const current = THEME_MODES[currentIndex] ?? THEME_MODES[0];
  const next = THEME_MODES[(currentIndex + 1) % THEME_MODES.length] ?? THEME_MODES[0];

  return (
    <button
      type="button"
      className="h-6 px-2 inline-flex items-center gap-1.5 rounded border text-[11px] hover:bg-[var(--taomni-control-hover)]"
      style={{
        borderColor: "var(--taomni-input-border)",
        background: "var(--taomni-input-bg)",
        color: "var(--taomni-text)",
      }}
      title={t("titlebar.cycleTheme", { mode: themeLabel(mode), resolved: resolvedTheme, next: themeLabel(next.mode) })}
      aria-label={t("titlebar.cycleThemeAria")}
      onClick={() => setMode(next.mode)}
    >
      {current.icon}
      <span>{themeLabel(mode)}</span>
    </button>
  );
}

function ThemeModeButton({
  mode,
  currentMode,
  onSelect,
  icon,
}: {
  mode: AppThemeMode;
  currentMode: AppThemeMode;
  onSelect: (mode: AppThemeMode) => void;
  icon: React.ReactNode;
}) {
  const themeLabel = useAppThemeI18nLabel();
  const selected = mode === currentMode;

  return (
    <button
      data-testid={`app-theme-${mode}`}
      type="button"
      aria-pressed={selected}
      className="h-9 px-3 inline-flex items-center gap-2 text-[12px] border-r last:border-r-0 border-[var(--taomni-input-border)]"
      style={{
        background: selected ? "var(--taomni-selected)" : "var(--taomni-input-bg)",
        color: selected ? "var(--taomni-accent)" : "var(--taomni-text)",
        fontWeight: selected ? 600 : 400,
      }}
      onClick={() => onSelect(mode)}
    >
      {icon}
      {themeLabel(mode)}
    </button>
  );
}
