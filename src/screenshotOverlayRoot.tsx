// P0-3: the screenshot overlay window's own root. It renders only the
// overlay and what the overlay needs (dialogs, theme tokens, UI font,
// renderer guards), so the window does not evaluate the main layout and
// every other feature module before it can draw the captured desktop.

import { useEffect } from "react";
import { ScreenshotOverlay } from "./components/screenshot/ScreenshotOverlay";
import { AppDialogProvider } from "./lib/appDialogs";
import { useAppTheme } from "./lib/appTheme";
import { getAppPlatform } from "./lib/runtime";
import { useWebviewGuards } from "./lib/webviewGuards";
import { readUiFontFamily, readUiFontSize } from "./stores/app/preferences";

export function ScreenshotOverlayRoot() {
  const { mode, resolvedTheme } = useAppTheme();
  useWebviewGuards();

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.appTheme = resolvedTheme;
    root.dataset.appThemeMode = mode;
    root.style.colorScheme = resolvedTheme;
    root.dataset.appPlatform = getAppPlatform();
  }, [mode, resolvedTheme]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--taomni-ui-font-family", readUiFontFamily());
    root.style.setProperty("--taomni-ui-font-size", `${readUiFontSize()}px`);
  }, []);

  return (
    <AppDialogProvider>
      <ScreenshotOverlay />
    </AppDialogProvider>
  );
}
