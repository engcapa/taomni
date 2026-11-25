import { useLayoutEffect } from "react";
import { useAppTheme } from "../lib/appTheme";
import { getAppPlatform } from "../lib/runtime";
import { UI_FONT_FAMILY_KEY, UI_FONT_SIZE_KEY, readUiFontFamily, readUiFontSize } from "../stores/app/preferences";

/** Apply appearance before paint, including windows that never mount the main store. */
export function useWindowAppearance(fontFamily?: string, fontSize?: number) {
  const { mode, resolvedTheme } = useAppTheme();
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.appTheme = resolvedTheme;
    root.dataset.appThemeMode = mode;
    root.dataset.appPlatform = getAppPlatform();
    root.style.colorScheme = resolvedTheme;
  }, [mode, resolvedTheme]);

  useLayoutEffect(() => {
    const style = document.documentElement.style;
    const apply = () => {
      style.setProperty("--taomni-ui-font-family", fontFamily ?? readUiFontFamily());
      style.setProperty("--taomni-ui-font-size", `${fontSize ?? readUiFontSize()}px`);
    };
    apply();
    if (fontFamily !== undefined && fontSize !== undefined) return;
    const refresh = (event: StorageEvent) => {
      if (event.key === null || event.key === UI_FONT_FAMILY_KEY || event.key === UI_FONT_SIZE_KEY) apply();
    };
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, [fontFamily, fontSize]);

  return resolvedTheme;
}
