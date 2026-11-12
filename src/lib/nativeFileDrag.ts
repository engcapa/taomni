import type { DragDropEvent } from "@tauri-apps/api/webview";
import { dispatchNativeFileDrop } from "./osFileDrop";

export const NATIVE_FILE_DRAG_EVENT = "taomni:native-file-drag";
export type NativeFileDragDetail =
  | { type: "enter" | "over"; clientX: number; clientY: number }
  | { type: "leave" };

/** Preserve the existing drop-only contract for terminals, chat and MFA while
 * publishing native hover/cancel events for directory drop-target feedback. */
export function dispatchNativeDragDrop(payload: DragDropEvent, scale = window.devicePixelRatio || 1): void {
  if (payload.type === "drop") {
    if (payload.paths.length) dispatchNativeFileDrop({
      paths: payload.paths,
      clientX: payload.position.x / scale,
      clientY: payload.position.y / scale,
    });
    window.dispatchEvent(new CustomEvent<NativeFileDragDetail>(NATIVE_FILE_DRAG_EVENT, { detail: { type: "leave" } }));
    return;
  }
  const detail: NativeFileDragDetail = payload.type === "leave"
    ? { type: "leave" }
    : { type: payload.type, clientX: payload.position.x / scale, clientY: payload.position.y / scale };
  window.dispatchEvent(new CustomEvent<NativeFileDragDetail>(NATIVE_FILE_DRAG_EVENT, { detail }));
}
