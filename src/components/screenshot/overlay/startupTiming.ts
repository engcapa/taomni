// Renderer side of the screenshot startup timing (P0-0b). QA builds only:
// marks are wall-clock epoch milliseconds in `window.__TAOMNI_OVERLAY_TIMING__`
// so the native QA scenario can align them with the backend stages. Other
// builds compile the body away.

interface OverlayTimingSlot {
  marks: Record<string, number>;
}

type TimingWindow = Window & { __TAOMNI_OVERLAY_TIMING__?: OverlayTimingSlot };

function slot(): OverlayTimingSlot {
  const target = window as TimingWindow;
  target.__TAOMNI_OVERLAY_TIMING__ ??= { marks: {} };
  return target.__TAOMNI_OVERLAY_TIMING__;
}

/** Record the first occurrence of `name` (later calls keep the first time). */
export function markOverlayStartup(name: string, at?: number): void {
  if (!__TAOMNI_QA_OVERLAY_TIMING__) return;
  const marks = slot().marks;
  marks[name] ??= at ?? performance.timeOrigin + performance.now();
}

/** Navigation start and first contentful paint of this renderer. */
export function observeOverlayPaint(): void {
  if (!__TAOMNI_QA_OVERLAY_TIMING__) return;
  markOverlayStartup("nav", performance.timeOrigin);
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === "first-contentful-paint") markOverlayStartup("fcp", performance.timeOrigin + entry.startTime);
      }
    }).observe({ type: "paint", buffered: true });
  } catch {
    // Paint timing is optional on older WebKit; the other marks still apply.
  }
}
