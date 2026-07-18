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
 * Open (or focus) the Sockscap window. The window is created on the Rust side
 * (`sockscap_open_window`) — matching the SFTP/notes detached windows — because
 * the main webview isn't granted the ACL permission to create windows itself.
 * Falls back to `window.open` in browser preview, where there's no backend.
 */
export async function openSockscapWindow(): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("sockscap_open_window");
  } catch {
    window.open(sockscapWindowUrl(), "sockscap", "width=1100,height=760");
  }
}
