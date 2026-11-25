import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Label of the webview this renderer runs in.
 *
 * Thread-scoped agent events are addressed to one window (issue #869), and the
 * bridge compares the payload's `windowLabel` with this one before rendering a
 * card. Returns `null` when the runtime exposes no label (jsdom unit tests, a
 * plain browser tab without the Tauri shim): callers must then accept the event
 * rather than drop a prompt nobody can answer.
 */
export function currentWindowLabel(): string | null {
  try {
    const label = getCurrentWindow().label;
    return label ? label : null;
  } catch {
    return null;
  }
}

/**
 * Whether an event addressed to `windowLabel` belongs to this window.
 *
 * Unlabelled events are broadcasts (the backend's fallback when the owning
 * window is gone) and are accepted by every window so the approval is not lost.
 */
export function addressesThisWindow(windowLabel: string | null | undefined): boolean {
  if (!windowLabel) return true;
  const mine = currentWindowLabel();
  return mine == null || mine === windowLabel;
}
