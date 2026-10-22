import { type ChatDrawerLayoutPrefs, type ChatDrawerPosition } from "./model";

export const CHAT_DRAWER_LAYOUT_STORAGE_KEY = "taomni.chatDrawer.layout.v1";

export const MIN_DRAWER_FLOATING_OPACITY = 0.65;

export const MAX_DRAWER_FLOATING_OPACITY = 1;

export function clampDrawerWidth(width: number): number {
  const viewportMax =
    typeof window === "undefined"
      ? 960
      : Math.max(320, Math.min(1120, window.innerWidth - 32));
  return Math.max(280, Math.min(viewportMax, Math.round(width)));
}

export function clampDrawerHeight(height: number): number {
  const viewportMax =
    typeof window === "undefined"
      ? 720
      : Math.max(260, Math.min(900, window.innerHeight - 32));
  return Math.max(220, Math.min(viewportMax, Math.round(height)));
}

export function clampDrawerFloatingOpacity(opacity: number): number {
  if (!Number.isFinite(opacity)) return MAX_DRAWER_FLOATING_OPACITY;
  const rounded = Math.round(opacity * 100) / 100;
  return Math.max(MIN_DRAWER_FLOATING_OPACITY, Math.min(MAX_DRAWER_FLOATING_OPACITY, rounded));
}

export function readDrawerLayoutPrefs(): ChatDrawerLayoutPrefs {
  const fallback: ChatDrawerLayoutPrefs = {
    position: "right",
    pinned: true,
    width: 380,
    height: 420,
    floatingOpacity: 1,
    ribbonOffsetRatio: 0.5,
  };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(CHAT_DRAWER_LAYOUT_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<ChatDrawerLayoutPrefs>;
    const position: ChatDrawerPosition =
      parsed.position === "left" || parsed.position === "right" || parsed.position === "top" || parsed.position === "bottom"
        ? parsed.position
        : fallback.position;
    const ribbonOffsetRatio =
      typeof parsed.ribbonOffsetRatio === "number" && Number.isFinite(parsed.ribbonOffsetRatio)
        ? Math.min(1, Math.max(0, parsed.ribbonOffsetRatio))
        : fallback.ribbonOffsetRatio;
    const floatingOpacity =
      typeof parsed.floatingOpacity === "number"
        ? clampDrawerFloatingOpacity(parsed.floatingOpacity)
        : fallback.floatingOpacity;
    return {
      position,
      pinned:
        typeof parsed.pinned === "boolean"
          ? parsed.pinned
          : position === "left" || position === "right",
      width: clampDrawerWidth(Number(parsed.width) || fallback.width),
      height: clampDrawerHeight(Number(parsed.height) || fallback.height),
      floatingOpacity,
      ribbonOffsetRatio,
    };
  } catch {
    return fallback;
  }
}

export function writeDrawerLayoutPrefs(prefs: Partial<ChatDrawerLayoutPrefs>) {
  if (typeof window === "undefined") return;
  try {
    const current = readDrawerLayoutPrefs();
    window.localStorage.setItem(
      CHAT_DRAWER_LAYOUT_STORAGE_KEY,
      JSON.stringify({ ...current, ...prefs }),
    );
  } catch {
    // Best-effort UI preference persistence.
  }
}

export const initialDrawerLayoutPrefs = readDrawerLayoutPrefs();
