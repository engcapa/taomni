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

/**
 * Whether the webview exposes the WebRTC `RTCPeerConnection` API. This is the
 * switch between the two LanChat media stacks: Windows (WebView2) and macOS
 * (WKWebView) expose it; Linux WebKitGTK does NOT (the build does not ship the
 * WebRTC DOM at all — confirmed, not a settings/timing issue), so those nodes
 * fall back to the Rust-native capture/encode/transport stack.
 */
export function hasWebRtc(): boolean {
  return typeof RTCPeerConnection === "function";
}

export type AppPlatform = "windows" | "macos" | "linux" | "unknown";

export function getAppPlatform(): AppPlatform {
  if (typeof window === "undefined") return "unknown";
  // The platform describes the host. Fall back to UA only if it is absent or
  // unrecognized, since compatibility UA tokens can name another platform.
  for (const value of [navigator.platform, navigator.userAgent]) {
    const platform = (value ?? "").toLowerCase();
    if (/mac|iphone|ipad|ipod/.test(platform)) return "macos";
    if (platform.includes("win")) return "windows";
    if (platform.includes("linux")) return "linux";
  }
  return "unknown";
}

