// IPC wrappers for the Feishu-style system screenshot & screen recording
// tool (Rust backend: src-tauri/src/screenshot/).
//
// Naming: Tauri commands are `screenshot_*`; this module exposes camelCase
// wrappers. All file payloads are temp PNG/GIF/MP4 paths on the local disk;
// load them in the UI with `convertFileSrc`.

import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriRuntime } from "./runtime";

export interface ScreenshotDisplay {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Display origin in the virtual desktop, physical pixels. */
  x: number;
  y: number;
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

export interface ScreenshotProbe {
  /** `granted` | `denied` | `notRequired` — OS screen-capture permission. */
  permission: string;
  /** Accessibility / input-injection permission (macOS scroll capture). */
  controlPermission: string;
  ffmpegAvailable: boolean;
  summary: string;
}

export interface OverlayInit {
  path: string;
  displayId: string | null;
  width: number;
  height: number;
}

export interface RecordingStarted {
  recordingId: string;
}

export type RecordFormat = "gif" | "mp4";

export async function listDisplays(): Promise<ScreenshotDisplay[]> {
  return invoke<ScreenshotDisplay[]>("screenshot_list_displays");
}

export async function captureFull(displayId?: string): Promise<ScreenshotFile> {
  return invoke<ScreenshotFile>("screenshot_capture_full", {
    displayId: displayId ?? null,
  });
}

export async function captureRegion(
  displayId: string | undefined,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<ScreenshotFile> {
  return invoke<ScreenshotFile>("screenshot_capture_region", {
    displayId: displayId ?? null,
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  });
}

/**
 * Scrolling capture over a display-relative region (physical pixels).
 * The overlay window must be hidden before calling — it would otherwise be
 * captured. Blocking; resolves with the stitched image.
 */
export async function scrollCapture(
  displayId: string | undefined,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<ScrollCaptureResult> {
  return invoke<ScrollCaptureResult>("screenshot_scroll_capture", {
    displayId: displayId ?? null,
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
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
 * Returns the file; feed it to copy/save.
 */
export async function saveDataUrl(dataUrl: string): Promise<ScreenshotFile> {
  return invoke<ScreenshotFile>("screenshot_save_data_url", { dataUrl });
}

export async function probeScreenshot(): Promise<ScreenshotProbe> {
  return invoke<ScreenshotProbe>("screenshot_probe");
}

/** Hide app windows, capture the display, open the fullscreen overlay. */
export async function openScreenshotOverlay(displayId?: string): Promise<void> {
  return invoke<void>("screenshot_open_overlay", {
    displayId: displayId ?? null,
  });
}

/** One-shot fetch of the pending overlay payload (call once on mount). */
export async function fetchOverlayInit(): Promise<OverlayInit> {
  return invoke<OverlayInit>("screenshot_overlay_init");
}

/** Close overlay/recorder windows and reshow hidden app windows. */
export async function closeScreenshotOverlay(): Promise<void> {
  return invoke<void>("screenshot_close_overlay");
}

export async function startRecording(
  displayId: string | undefined,
  region: { x: number; y: number; width: number; height: number } | null,
  format: RecordFormat,
  fps?: number,
): Promise<RecordingStarted> {
  return invoke<RecordingStarted>("screenshot_start_recording", {
    displayId: displayId ?? null,
    x: region ? Math.round(region.x) : null,
    y: region ? Math.round(region.y) : null,
    width: region ? Math.round(region.width) : null,
    height: region ? Math.round(region.height) : null,
    format,
    fps: fps ?? null,
  });
}

export async function stopRecording(recordingId: string): Promise<ScreenshotFile> {
  return invoke<ScreenshotFile>("screenshot_stop_recording", { recordingId });
}

export async function cancelRecording(recordingId: string): Promise<void> {
  return invoke<void>("screenshot_cancel_recording", { recordingId });
}

/** Which recording the recorder-bar window controls (null when idle). */
export async function currentRecording(): Promise<string | null> {
  return invoke<string | null>("screenshot_current_recording");
}

/** Local file path -> URL usable in <img> / canvas. */
export function screenshotFileUrl(path: string): string {
  return convertFileSrc(path);
}

/** True when running inside the screenshot overlay window. */
export function isScreenshotOverlayWindow(): boolean {
  if (!isTauriRuntime()) return false;
  try {
    return getCurrentWindow().label === "screenshot-overlay";
  } catch {
    return false;
  }
}

/** True when running inside the recorder bar window. */
export function isScreenshotRecorderWindow(): boolean {
  if (!isTauriRuntime()) return false;
  try {
    return getCurrentWindow().label === "screenshot-recorder";
  } catch {
    return false;
  }
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
 * Convert a CSS-pixel selection rect to physical device pixels for the
 * capture backend (`scale` = image natural size / displayed size).
 */
export function toPhysicalRect(
  r: ScreenshotRect,
  scale: number,
): { x: number; y: number; width: number; height: number } {
  return {
    x: r.x * scale,
    y: r.y * scale,
    width: r.w * scale,
    height: r.h * scale,
  };
}
