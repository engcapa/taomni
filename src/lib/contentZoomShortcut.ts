import { getAppPlatform } from "./runtime";

export type ContentZoomAction = "in" | "out" | "reset";
type ZoomKey = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "isComposing" | "keyCode"> & Partial<Pick<KeyboardEvent, "code">>;

export function contentZoomShortcut(event: ZoomKey, mac = getAppPlatform() === "macos"): ContentZoomAction | undefined {
  if (event.isComposing || event.keyCode === 229 || event.altKey) return;
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return;
  if (event.key === "+" || event.key === "=" || event.code === "NumpadAdd") return "in";
  if (event.key === "-" || event.key === "_" || event.code === "NumpadSubtract") return "out";
  if (event.key === "0" || event.code === "Numpad0") return "reset";
}

export function zoomedFontSize(base: number, offset: number) {
  return Math.max(8, Math.min(32, base + offset));
}

export function nextFontOffset(action: ContentZoomAction, base: number, offset: number) {
  if (action === "reset") return 0;
  return zoomedFontSize(zoomedFontSize(base, offset), action === "in" ? 1 : -1) - base;
}
