// Phone terminal display settings and the box sizing that keeps xterm's fit
// addon from feeding its own result back into the container height.

export const FONT_MIN = 9;
export const FONT_MAX = 20;
const FONT_DEFAULT = 13;
const FONT_KEY = "taomni.mobile.terminalFontSize.v1";

export const MONO_FONT = 'ui-monospace, "SF Mono", Menlo, Monaco, Consolas, "Roboto Mono", "Noto Sans Mono", "Liberation Mono", monospace';

export const clampFontSize = (value: number) => Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(value)));

/** Per-device convenience only: a missing or blocked store falls back to the default. */
export function loadFontSize(): number {
  try {
    const value = Number(localStorage.getItem(FONT_KEY));
    return Number.isFinite(value) && value > 0 ? clampFontSize(value) : FONT_DEFAULT;
  } catch { return FONT_DEFAULT; }
}

export function saveFontSize(value: number) {
  try { localStorage.setItem(FONT_KEY, String(clampFontSize(value))); } catch { /* keep the in-memory size */ }
}

const FULLSCREEN_KEY = "taomni.mobile.terminalFullscreen.v1";
const KEYS_KEY = "taomni.mobile.terminalKeys.v1";

function loadFlag(key: string, fallback: boolean): boolean {
  try { const value = localStorage.getItem(key); return value === null ? fallback : value === "1"; } catch { return fallback; }
}

function saveFlag(key: string, value: boolean) {
  try { localStorage.setItem(key, value ? "1" : "0"); } catch { /* keep the in-memory choice */ }
}

export const loadFullscreen = () => loadFlag(FULLSCREEN_KEY, true);
export const saveFullscreen = (value: boolean) => saveFlag(FULLSCREEN_KEY, value);
/** Whether the on-screen key rows are shown; hiding them gives the output more rows. */
export const loadKeysOpen = () => loadFlag(KEYS_KEY, true);
export const saveKeysOpen = (value: boolean) => saveFlag(KEYS_KEY, value);

export type InputMode = "compact" | "system" | "direct" | "hidden";
const INPUT_MODE_KEY = "taomni.mobile.terminalInputMode.v1";
export function loadInputMode(): InputMode {
  try { const value = localStorage.getItem(INPUT_MODE_KEY); return value === "system" || value === "direct" || value === "hidden" ? value : "compact"; } catch { return "compact"; }
}
export function saveInputMode(mode: InputMode) {
  try { localStorage.setItem(INPUT_MODE_KEY, mode); } catch { /* keep in memory */ }
}

function setStyle(element: HTMLElement, property: string, value: string) {
  if (element.style.getPropertyValue(property) !== value) element.style.setProperty(property, value);
}

/**
 * Pins the terminal box to a pixel height from the live viewport. An engine
 * that drops the css height leaves the box content-sized, and the fit addon
 * then grows it by a row per observation; a pixel height never depends on the
 * terminal's own content.
 *
 * Inline, the box takes about half of the layout viewport. Full screen, the
 * card covers the visual viewport (which shrinks when the soft keyboard opens),
 * and the box gets whatever the card's other rows leave, so the key bar stays
 * directly above the keyboard.
 */
export function pinTerminal(card: HTMLElement, screen: HTMLElement, fullscreen: boolean) {
  if (!fullscreen) {
    setStyle(card, "top", "");
    setStyle(card, "max-height", "");
    setStyle(card, "height", "");
    delete card.dataset.compact;
    setStyle(screen, "height", `${Math.round(Math.max(230, window.innerHeight * 0.48))}px`);
    return;
  }
  const viewport = window.visualViewport;
  const height = Math.floor(viewport?.height ?? window.innerHeight);
  setStyle(card, "top", `${Math.round(viewport?.offsetTop ?? 0)}px`);
  setStyle(card, "max-height", `${height}px`);
  setStyle(card, "height", `${height}px`);
  card.dataset.compact = String(height < 480);
  // Flex layout gives the output whatever is left after the input and keys.
  // Unlike measuring scrollHeight, it also responds to child-owned draft and
  // history changes without asking TerminalView to re-render.
  setStyle(screen, "height", "100%");
}
