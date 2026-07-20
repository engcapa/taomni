// Standalone Sockscap window routing (plan §9, §11). The Sockscap UI runs in
// its own window at `#sockscap`. In the desktop app this is a Tauri webview
// window; in browser preview it's a plain `window.open`. Closing the window
// only hides it (the engine keeps running) — enforced by the desktop shell.

const SOCKSCAP_HASH = "sockscap";
const SOCKSCAP_LABEL = "sockscap";

function tauriWindowLabel(): string | null {
  if (typeof window === "undefined") return null;
  try {
    // Tauri 2 injects the current window label into metadata used by the API.
    // Prefer this over the URL hash: Vite's dev server can drop/rewrite
    // `index.html#sockscap` fragments, which previously mounted MainLayout
    // inside the sockscap webview (blank/white chrome, exit handler traps X).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const fromMeta =
      w.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ??
      w.__TAURI_METADATA__?.currentWindow?.label ??
      null;
    if (typeof fromMeta === "string" && fromMeta.length > 0) return fromMeta;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * True when the current window was opened as the Sockscap window.
 */
export function detectSockscapRoute(): boolean {
  if (typeof window === "undefined") return false;

  if (tauriWindowLabel() === SOCKSCAP_LABEL) return true;

  try {
    const hash = window.location.hash.replace(/^#/, "");
    // Accept `#sockscap`, `#sockscap=1`, and rare `#/sockscap` forms.
    if (
      hash === SOCKSCAP_HASH ||
      hash.startsWith(`${SOCKSCAP_HASH}=`) ||
      hash === `/${SOCKSCAP_HASH}` ||
      hash.startsWith(`/${SOCKSCAP_HASH}?`)
    ) {
      return true;
    }
    const url = new URL(window.location.href);
    return url.searchParams.get(SOCKSCAP_HASH) !== null;
  } catch {
    return false;
  }
}

/** URL the Sockscap window is launched at (browser preview). */
export function sockscapWindowUrl(): string {
  const url = new URL(window.location.href);
  url.searchParams.set(SOCKSCAP_HASH, "1");
  url.hash = SOCKSCAP_HASH;
  return url.toString();
}

/**
 * Open (or focus) the Sockscap window. The window is created on the Rust side
 * (`sockscap_open_window`) — matching the SFTP/notes detached windows — because
 * the main webview isn't granted the ACL permission to create windows itself.
 */
export async function openSockscapWindow(): Promise<void> {
  const { isTauriRuntime } = await import("./runtime");
  if (!isTauriRuntime()) {
    window.open(sockscapWindowUrl(), "sockscap", "width=1100,height=760");
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("sockscap_open_window");
}

/** Hide the Sockscap window without stopping the engine (plan §9). */
export async function hideSockscapWindow(): Promise<void> {
  const { isTauriRuntime } = await import("./runtime");
  if (!isTauriRuntime()) {
    window.close();
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke("sockscap_hide_window");
  } catch {
    // Last-resort escape if hide is denied: destroy so the user is never stuck.
    await invoke("sockscap_destroy_window").catch(() => undefined);
  }
}
