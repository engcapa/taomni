/**
 * Detect whether we're running inside the Tauri webview (desktop app)
 * or the plain browser dev server.
 */
export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  };
  return !!(w.__TAURI__ || w.__TAURI_INTERNALS__);
}

export const RUNTIME_KIND: "tauri" | "browser" =
  isTauriRuntime() ? "tauri" : "browser";
