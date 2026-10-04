// IPC wrappers for the Feishu-style system screenshot & screen recording
// tool (Rust backend: src-tauri/src/screenshot/).
//
// Naming: Tauri commands are `screenshot_*`; this module exposes camelCase
// wrappers. File payloads are temp PNG/GIF/MP4 artifacts owned by the
// backend; load them with `loadScreenshotUrl` (same-origin blob URLs, so
// canvases drawing them stay exportable).

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriRuntime } from "./runtime";

export interface ScreenshotDisplay {
  id: string;
  name: string;
  /** Physical pixels. */
  width: number;
  height: number;
  /** Display origin in the virtual desktop, physical pixels. */
  x: number;
  y: number;
  scaleFactor: number;
  primary: boolean;
}

export interface ScreenshotFile {
  path: string;
  width: number;
  height: number;
}

export interface ScrollCaptureResult extends ScreenshotFile {
  frames: number;
}

export interface RecordingFile extends ScreenshotFile {
  frames: number;
  durationMs: number;
}

export interface ScreenshotProbe {
  /** `granted` | `denied` | `notRequired` — OS screen-capture permission. */
  permission: string;
  /** Accessibility / input-injection permission (macOS scroll capture). */
  controlPermission: string;
  mp4Available: boolean;
  ocrAvailable: boolean;
  summary: string;
}

export interface OverlayInit {
  path: string;
  displayId: string;
  /** Physical pixels of the captured display. */
  width: number;
  height: number;
  scaleFactor: number;
  /** Visible part of the invoking window, in display-relative physical pixels. */
  windowRegion?: PhysicalRect | null;
}

export interface RecordingStarted {
  recordingId: string;
}

export interface ShortcutStatus {
  /** Configured chord (Tauri accelerator syntax); empty when disabled. */
  accelerator: string;
  defaultAccelerator: string;
  enabled: boolean;
  /** Whether the OS accepted the global registration. */
  registered: boolean;
  error: string | null;
}

export interface PinInit {
  path: string;
  width: number;
  height: number;
}

export type RecordFormat = "gif" | "mp4";

/** Event the backend emits when a recording stops on its own. */
export const RECORDING_ENDED_EVENT = "screenshot://recording-ended";
export const SCROLL_PROGRESS_EVENT = "screenshot://scroll-progress";
export const SCREENSHOT_OPEN_FAILED_EVENT = "screenshot://open-failed";

export interface ScrollStatus { frames: number; }

export async function scrollStatus(): Promise<ScrollStatus | null> {
  return invoke<ScrollStatus | null>("screenshot_scroll_status");
}

export async function stopScrollCapture(cancel = false): Promise<void> {
  return invoke<void>("screenshot_stop_scroll_capture", { cancel });
}

export async function listDisplays(): Promise<ScreenshotDisplay[]> {
  return invoke<ScreenshotDisplay[]>("screenshot_list_displays");
}

export async function captureFull(displayId?: string): Promise<ScreenshotFile> {
  return invoke<ScreenshotFile>("screenshot_capture_full", {
    displayId: displayId ?? null,
  });
}

/**
 * Scrolling capture over a display-relative region (physical pixels).
 * The backend hides the overlay while it scrolls and shows it again.
 */
export async function scrollCapture(
  displayId: string | undefined,
  region: PhysicalRect,
): Promise<ScrollCaptureResult> {
  return invoke<ScrollCaptureResult>("screenshot_scroll_capture", {
    displayId: displayId ?? null,
    ...region,
  });
}

export async function copyImageToClipboard(path: string): Promise<void> {
  return invoke<void>("screenshot_copy_image", { path });
}

export async function saveImageToFile(path: string, dest: string): Promise<void> {
  return invoke<void>("screenshot_save_image", { path, dest });
}

/**
 * Write an annotated `data:image/png;base64,...` canvas URL to a temp PNG.
 * Returns the file; feed it to copy/save/pin.
 */
export async function saveDataUrl(dataUrl: string): Promise<ScreenshotFile> {
  return invoke<ScreenshotFile>("screenshot_save_data_url", { dataUrl });
}

export async function probeScreenshot(): Promise<ScreenshotProbe> {
  return invoke<ScreenshotProbe>("screenshot_probe");
}

/** Hide app windows, capture the display, open the fullscreen overlay. */
export async function openScreenshotOverlay(displayId?: string, includeCurrentWindow = false): Promise<void> {
  return invoke<void>("screenshot_open_overlay", {
    displayId: displayId ?? null,
    includeCurrentWindow,
  });
}

/** The pending overlay payload (call on mount). */
export async function fetchOverlayInit(): Promise<OverlayInit> {
  return invoke<OverlayInit>("screenshot_overlay_init");
}

/** Tell the backend the overlay now shows another background image. */
export async function updateOverlayImage(file: ScreenshotFile): Promise<void> {
  return invoke<void>("screenshot_overlay_update", {
    path: file.path,
    width: file.width,
    height: file.height,
  });
}

/** End the capture session: close tool windows, reshow app windows. */
export async function closeScreenshotOverlay(): Promise<void> {
  return invoke<void>("screenshot_close_overlay");
}

export async function pinToScreen(path: string): Promise<string> {
  return invoke<string>("screenshot_pin_to_screen", { path });
}

export async function fetchPinInit(): Promise<PinInit> {
  return invoke<PinInit>("screenshot_pin_init");
}

export async function closePin(label: string): Promise<void> {
  return invoke<void>("screenshot_close_pin", { label });
}

export interface OcrResponse {
  text: string;
  langs: string;
}

export async function ocrImage(path: string): Promise<OcrResponse> {
  return invoke<OcrResponse>("screenshot_ocr", { path });
}

export interface RedactResponse {
  boxes: { x: number; y: number; w: number; h: number; kind: string }[];
  count: number;
}

export async function autoRedact(path: string): Promise<RedactResponse> {
  return invoke<RedactResponse>("screenshot_auto_redact", { path });
}

export async function startRecording(
  displayId: string | undefined,
  region: PhysicalRect | null,
  format: RecordFormat,
  fps?: number,
): Promise<RecordingStarted> {
  return invoke<RecordingStarted>("screenshot_start_recording", {
    displayId: displayId ?? null,
    x: region ? region.x : null,
    y: region ? region.y : null,
    width: region ? region.width : null,
    height: region ? region.height : null,
    format,
    fps: fps ?? null,
  });
}

export async function stopRecording(recordingId: string): Promise<RecordingFile> {
  return invoke<RecordingFile>("screenshot_stop_recording", { recordingId });
}

export async function cancelRecording(recordingId: string): Promise<void> {
  return invoke<void>("screenshot_cancel_recording", { recordingId });
}

/** Which recording the recorder-bar window controls (null when idle). */
export async function currentRecording(): Promise<string | null> {
  return invoke<string | null>("screenshot_current_recording");
}

export interface RecordingStatus {
  recordingId: string;
  finished: boolean;
  stoppedByUser: boolean;
  region: PhysicalRect | null;
}

export async function recordingStatus(): Promise<RecordingStatus | null> {
  return invoke<RecordingStatus | null>("screenshot_recording_status");
}

export async function shortcutStatus(): Promise<ShortcutStatus> {
  return invoke<ShortcutStatus>("screenshot_shortcut_status");
}

/** `null` resets to the default chord, `""` disables. */
export async function setShortcut(accelerator: string | null): Promise<ShortcutStatus> {
  return invoke<ShortcutStatus>("screenshot_shortcut_set", { accelerator });
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  gif: "image/gif",
  mp4: "video/mp4",
};

/**
 * Object URL for a backend artifact. Same-origin blob URLs keep canvases
 * that draw the image untainted (asset-protocol URLs are cross-origin and
 * would block `toDataURL` / `getImageData`). Revoke it when done.
 */
export async function loadScreenshotUrl(path: string): Promise<string> {
  // Browser preview: the stub hands out data/blob URLs directly.
  if (!isTauriRuntime() || /^(data|blob|https?):/.test(path)) return path;
  const bytes = await invoke<ArrayBuffer>("screenshot_read_file", { path });
  const ext = path.split(".").pop()?.toLowerCase() ?? "png";
  return URL.createObjectURL(new Blob([bytes], { type: MIME_BY_EXT[ext] ?? "application/octet-stream" }));
}

export function revokeScreenshotUrl(url: string | null | undefined): void {
  if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
}

function currentLabel(): string | null {
  if (!isTauriRuntime()) return null;
  try {
    return getCurrentWindow().label;
  } catch {
    return null;
  }
}

/** True when running inside the screenshot overlay window. */
export function isScreenshotOverlayWindow(): boolean {
  return currentLabel() === "screenshot-overlay";
}

/** True when running inside the recorder bar window. */
export function isScreenshotRecorderWindow(): boolean {
  return currentLabel() === "screenshot-recorder";
}

export function isScreenshotScrollWindow(): boolean {
  return currentLabel() === "screenshot-scroll";
}

export function isScreenshotBoundaryWindow(): boolean {
  return currentLabel()?.startsWith("screenshot-boundary-") ?? false;
}

/** True when running inside a pinned-screenshot window. */
export function isScreenshotPinWindow(): boolean {
  return currentLabel()?.startsWith("screenshot-pin-") ?? false;
}

/** True when running inside the native QA content fixture window. */
export function isScreenshotQaFixtureWindow(): boolean {
  return currentLabel() === "screenshot-qa-fixture";
}

/** A 2D point in CSS pixels. */
export interface ScreenshotPoint {
  x: number;
  y: number;
}

/** A rectangle in CSS pixels (`x`/`y` = top-left, `w`/`h` = size). */
export interface ScreenshotRect extends ScreenshotPoint {
  w: number;
  h: number;
}

/** A rectangle in physical (device) pixels, integral. */
export interface PhysicalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Normalize two drag corners into a top-left-origin rectangle.
 * Pure geometry for region selection; the overlay renders this.
 */
export function normalizeRect(a: ScreenshotPoint, b: ScreenshotPoint): ScreenshotRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

/**
 * Convert a CSS-pixel selection rect to integral physical pixels clamped to
 * the image. `sx`/`sy` = image natural size / displayed size per axis (the
 * overlay can be a few CSS px off the display size on some platforms).
 */
export function toPhysicalRect(
  r: ScreenshotRect,
  sx: number,
  sy: number = sx,
  bounds?: { width: number; height: number },
): PhysicalRect {
  let x = Math.max(0, Math.round(r.x * sx));
  let y = Math.max(0, Math.round(r.y * sy));
  let right = Math.round((r.x + r.w) * sx);
  let bottom = Math.round((r.y + r.h) * sy);
  if (bounds) {
    x = Math.min(x, Math.max(0, bounds.width - 1));
    y = Math.min(y, Math.max(0, bounds.height - 1));
    right = Math.min(right, bounds.width);
    bottom = Math.min(bottom, bounds.height);
  }
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

/**
 * Tauri accelerator (`Control+Alt+A`) -> label for the current platform
 * (`Ctrl+Alt+A`, `⌃⌘A` on macOS).
 */
export function formatAccelerator(accelerator: string, mac: boolean): string {
  if (!accelerator) return "";
  const parts = accelerator.split("+").map((p) => p.trim());
  const key = parts.pop() ?? "";
  const keyLabel = key.replace(/^Key/, "").replace(/^Digit/, "");
  const names: Record<string, [string, string]> = {
    control: ["Ctrl", "⌃"],
    ctrl: ["Ctrl", "⌃"],
    alt: ["Alt", "⌥"],
    option: ["Alt", "⌥"],
    shift: ["Shift", "⇧"],
    super: ["Win", "⌘"],
    cmd: ["Win", "⌘"],
    command: ["Win", "⌘"],
    meta: ["Win", "⌘"],
    commandorcontrol: ["Ctrl", "⌘"],
    cmdorctrl: ["Ctrl", "⌘"],
  };
  const mods = parts.map((p) => names[p.toLowerCase()]?.[mac ? 1 : 0] ?? p);
  return mac ? `${mods.join("")}${keyLabel}` : [...mods, keyLabel].join("+");
}

/**
 * Keyboard event -> Tauri accelerator, or null while only modifiers are
 * held. Uses `event.code` so layouts and dead keys do not change the chord.
 */
export function acceleratorFromEvent(event: {
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  code: string;
}): string | null {
  const code = event.code;
  if (!code || /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(code)) return null;
  const mods: string[] = [];
  if (event.ctrlKey) mods.push("Control");
  if (event.altKey) mods.push("Alt");
  if (event.shiftKey) mods.push("Shift");
  if (event.metaKey) mods.push("Super");
  return [...mods, code].join("+");
}

/** Whether a keyboard event matches a Tauri accelerator. */
export function eventMatchesAccelerator(
  event: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; code: string },
  accelerator: string,
): boolean {
  if (!accelerator) return false;
  const parts = accelerator.split("+").map((p) => p.trim().toLowerCase());
  const key = parts.pop() ?? "";
  const has = (...names: string[]) => parts.some((p) => names.includes(p));
  const code = event.code.toLowerCase();
  const keyMatches =
    code === key ||
    code === `key${key}` ||
    code === `digit${key}` ||
    (key.length === 1 && code === `key${key}`);
  return (
    keyMatches &&
    event.ctrlKey === has("control", "ctrl") &&
    event.altKey === has("alt", "option") &&
    event.shiftKey === has("shift") &&
    event.metaKey === has("super", "cmd", "command", "meta")
  );
}
