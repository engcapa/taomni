import { afterEach, describe, expect, it } from "vitest";
import { isNativeScreenshotOverlay } from "./screenshotOverlayBoot";

type Internals = { metadata?: { currentWindow?: { label?: string } } };

function setWindow(label: string | null, hash: string) {
  const target = window as unknown as { __TAURI_INTERNALS__?: Internals };
  if (label === null) delete target.__TAURI_INTERNALS__;
  else target.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label } } };
  window.location.hash = hash;
}

afterEach(() => setWindow(null, ""));

describe("screenshot overlay boot", () => {
  it("selects the dedicated root only for the native overlay window", () => {
    setWindow("screenshot-overlay", "#screenshot-overlay");
    expect(isNativeScreenshotOverlay()).toBe(true);
    // Pin document editor and the opaque fallback route share the window label.
    setWindow("screenshot-overlay", "#screenshot-overlay-document");
    expect(isNativeScreenshotOverlay()).toBe(true);
    setWindow("main", "#screenshot-overlay");
    expect(isNativeScreenshotOverlay()).toBe(false);
    // Browser preview keeps the full app so stub navigation still routes.
    setWindow(null, "#screenshot-overlay");
    expect(isNativeScreenshotOverlay()).toBe(false);
  });
});
