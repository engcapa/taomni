// First module evaluated by `main.tsx` (after the WebView compatibility
// shims). In the native screenshot overlay window it records the renderer
// entry mark and starts fetching/decoding the base image (P0-5) before React
// and the overlay UI are evaluated.

import { startOverlayPrefetch } from "./components/screenshot/overlay/prefetch";
import { markOverlayStartup, observeOverlayPaint } from "./components/screenshot/overlay/startupTiming";

export { markOverlayStartup };

/** Window label of the native overlay (`screenshot::OVERLAY_LABEL`). */
const OVERLAY_LABEL = "screenshot-overlay";

/**
 * Native overlay windows (selection overlay and pin document editor) get the
 * dedicated root. Browser preview keeps the full app: its stubs navigate
 * between routes with in-page hash changes.
 */
export function isNativeScreenshotOverlay(): boolean {
  if (typeof window === "undefined") return false;
  const internals = (window as unknown as {
    __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } };
  }).__TAURI_INTERNALS__;
  return internals?.metadata?.currentWindow?.label === OVERLAY_LABEL
    && location.hash.startsWith("#screenshot-overlay");
}

export const SCREENSHOT_OVERLAY_BOOT = isNativeScreenshotOverlay();

if (SCREENSHOT_OVERLAY_BOOT) {
  markOverlayStartup("entry");
  observeOverlayPaint();
  startOverlayPrefetch();
}
