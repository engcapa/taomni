import { useT, type TranslateFn } from "./index";
import type { AppThemeMode } from "../appTheme";

export function appThemeModeI18nLabel(t: TranslateFn, mode: AppThemeMode): string {
  switch (mode) {
    case "system":
      return t("theme.system");
    case "dark":
      return t("theme.dark");
    case "light":
    default:
      return t("theme.light");
  }
}

export function useAppThemeI18nLabel() {
  const t = useT();
  return (mode: AppThemeMode) => appThemeModeI18nLabel(t, mode);
}
