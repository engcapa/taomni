// P0-5: start fetching and decoding the overlay's base image as soon as the
// overlay renderer evaluates its first module, in parallel with loading React
// and the overlay UI. The init effect consumes the result; without a
// prefetch it loads the same payload itself.

import { captureFull, fetchOverlayInit, isScreenshotOverlayWindow, type OverlayInit } from "../../../lib/screenshot";
import { loadArtifact } from "./images";
import { markOverlayStartup } from "./startupTiming";

export interface OverlayPayload {
  init: OverlayInit;
  img: HTMLImageElement;
  url: string;
}

/** Backend error for "no backend session": only then may the overlay capture itself. */
const NO_PENDING_OVERLAY = "no pending screenshot overlay";

export function isNoPendingOverlay(error: unknown): boolean {
  return String(error instanceof Error ? error.message : error).includes(NO_PENDING_OVERLAY);
}

/** Session generation of a payload that failed to load (for the ready signal). */
export function failedOverlayGeneration(error: unknown): number | null {
  const generation = (error as { overlayGeneration?: unknown } | null)?.overlayGeneration;
  return typeof generation === "number" ? generation : null;
}

async function loadPayload(init: OverlayInit): Promise<OverlayPayload> {
  markOverlayStartup("init");
  try {
    const loaded = await loadArtifact(init.path, () => markOverlayStartup("read"));
    markOverlayStartup("decode");
    return { init, ...loaded };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    throw Object.assign(failure, { overlayGeneration: init.generation ?? null });
  }
}

let pending: Promise<OverlayPayload> | null = null;

export function startOverlayPrefetch(): void {
  if (pending) return;
  pending = fetchOverlayInit().then(loadPayload);
  // The consumer observes the rejection; never report it as unhandled.
  pending.catch(() => undefined);
}

export function takeOverlayPrefetch(): Promise<OverlayPayload> | null {
  const prefetched = pending;
  pending = null;
  return prefetched;
}

/**
 * The overlay payload: the prefetched one, or a fresh load. Only a missing
 * backend session in a dev/browser direct open falls back to a live capture.
 * The native overlay window is always opened by a backend session; when that
 * session failed or was cancelled it must not capture while the app windows
 * may be visible again.
 */
export async function resolveOverlayPayload(): Promise<OverlayPayload> {
  const prefetched = takeOverlayPrefetch();
  if (prefetched) {
    try {
      return await prefetched;
    } catch (error) {
      if (!isNoPendingOverlay(error)) throw error;
    }
  }
  let init: OverlayInit;
  try {
    init = await fetchOverlayInit();
  } catch (error) {
    if (!isNoPendingOverlay(error) || isScreenshotOverlayWindow()) throw error;
    const file = await captureFull();
    init = { path: file.path, displayId: "", width: file.width, height: file.height, scaleFactor: 1 };
  }
  return loadPayload(init);
}
