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

export type AppPlatform = "windows" | "macos" | "linux" | "unknown";

export function getAppPlatform(): AppPlatform {
  if (typeof window === "undefined") return "unknown";
  const userAgent = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (userAgent.includes("mac") || userAgent.includes("iphone") || userAgent.includes("ipad") || userAgent.includes("ipod")) return "macos";
  if (userAgent.includes("win")) return "windows";
  if (userAgent.includes("linux")) return "linux";
  return "unknown";
}

