// Standalone Sockscap window routing (plan §9, §11). The Sockscap UI runs in
// its own window at `#sockscap`. In the desktop app this is a Tauri webview
// window; in browser preview it's a plain `window.open`. Closing the window
// only hides it (the engine keeps running) — enforced by the desktop shell.

const SOCKSCAP_HASH = "sockscap";

/** True when the current window was opened as the Sockscap window. */
export function detectSockscapRoute(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const hash = window.location.hash.replace(/^#/, "");
    if (hash === SOCKSCAP_HASH) return true;
    const url = new URL(window.location.href);
    return url.searchParams.get(SOCKSCAP_HASH) !== null;
  } catch {
    return false;
  }
}

/** URL the Sockscap window is launched at. */
export function sockscapWindowUrl(): string {
  const url = new URL(window.location.href);
  url.searchParams.set(SOCKSCAP_HASH, "1");
  url.hash = "";
  return url.toString();
}

/**
 * Open (or focus) the Sockscap window. Uses the Tauri window API when
 * available and falls back to `window.open` in browser preview.
 */
export async function openSockscapWindow(): Promise<void> {
  try {
    const mod = await import("@tauri-apps/api/webviewWindow");
    const existing = await mod.WebviewWindow.getByLabel("sockscap");
    if (existing) {
      await existing.show();
      await existing.setFocus();
      return;
    }
    const win = new mod.WebviewWindow("sockscap", {
      url: `index.html#${SOCKSCAP_HASH}`,
      title: "Sockscap",
      width: 1100,
      height: 760,
    });
    win.once("tauri://error", () => {
      window.open(sockscapWindowUrl(), "sockscap", "width=1100,height=760");
    });
  } catch {
    window.open(sockscapWindowUrl(), "sockscap", "width=1100,height=760");
  }
}
