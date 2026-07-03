import { Monitor, Moon, Sun } from "lucide-react";
import { useAppTheme, type AppThemeMode } from "../../lib/appTheme";
import { useT } from "../../lib/i18n";
import { useAppThemeI18nLabel } from "../../lib/i18n/labels";
import { ThemePreviewSelect } from "../theme/ThemePreviewSelect";
import { AppThemeLinePreview } from "../theme/themePreviews";

const THEME_MODES: Array<{ mode: AppThemeMode; icon: React.ReactNode }> = [
  { mode: "light", icon: <Sun className="w-4 h-4" /> },
  { mode: "dark", icon: <Moon className="w-4 h-4" /> },
  { mode: "system", icon: <Monitor className="w-4 h-4" /> },
];

export function AppThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const { mode, resolvedTheme, setMode } = useAppTheme();
  const t = useT();
  const themeLabel = useAppThemeI18nLabel();
  const options = THEME_MODES.map((item) => ({
    value: item.mode,
    label: themeLabel(item.mode),
    preview: <AppThemeLinePreview mode={item.mode} />,
    testId: `app-theme-${item.mode}`,
  }));

  if (compact) {
    return (
      <div className="inline-flex items-center gap-1.5 text-[11px]">
        <span className="text-[var(--taomni-text-muted)]">{t("settings.themeLabel")}</span>
        <ThemePreviewSelect
          value={mode}
          options={options}
          ariaLabel={t("titlebar.appThemeAria")}
          testId="app-theme-select"
          className="w-[260px]"
          title={t("settings.appThemeCurrent", { mode: themeLabel(mode), resolved: resolvedTheme })}
          onChange={(next) => setMode(next as AppThemeMode)}
        />
      </div>
    );
  }

  return (
    <ThemePreviewSelect
      value={mode}
      options={options}
      ariaLabel={t("titlebar.appThemeAria")}
      testId="app-theme-select"
      className="w-full max-w-[360px]"
      onChange={(next) => setMode(next as AppThemeMode)}
    />
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
