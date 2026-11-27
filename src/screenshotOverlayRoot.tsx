// P0-3: the screenshot overlay window's own root. It renders only the
// overlay and what the overlay needs (dialogs, theme tokens, UI font,
// renderer guards), so the window does not evaluate the main layout and
// every other feature module before it can draw the captured desktop.

import { ScreenshotOverlay } from "./components/screenshot/ScreenshotOverlay";
import { ScreenshotSessionHost } from "./components/screenshot/overlay/ScreenshotSessionHost";
import { AppDialogProvider } from "./lib/appDialogs";
import { useWindowAppearance } from "./hooks/useWindowAppearance";
import { useWebviewGuards } from "./lib/webviewGuards";

export function ScreenshotOverlayRoot() {
  useWindowAppearance();
  useWebviewGuards();

  return (
    <AppDialogProvider>
      <ScreenshotSessionHost><ScreenshotOverlay /></ScreenshotSessionHost>
    </AppDialogProvider>
  );
}
