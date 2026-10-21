import { normalizeRect } from "../../../lib/screenshot";
import { type CssRect } from "../AnnotationCanvas";
import { type Handle } from "./types";

/** Selections smaller than this (CSS px) are treated as a click. */
export const MIN_SEL = 6;

export const HANDLE = 8;

export function clampRect(r: CssRect, vw: number, vh: number): CssRect {
  const w = Math.min(r.w, vw);
  const h = Math.min(r.h, vh);
  return { x: Math.min(Math.max(0, r.x), vw - w), y: Math.min(Math.max(0, r.y), vh - h), w, h };
}

/** Apply a handle drag of (dx, dy) to the rect captured at drag start. */
export function dragRect(start: CssRect, handle: Handle, dx: number, dy: number, vw: number, vh: number): CssRect {
  if (handle === "move") {
    return clampRect({ ...start, x: start.x + dx, y: start.y + dy }, vw, vh);
  }
  let x1 = start.x;
  let y1 = start.y;
  let x2 = start.x + start.w;
  let y2 = start.y + start.h;
  if (handle.includes("w")) x1 += dx;
  if (handle.includes("e")) x2 += dx;
  if (handle.includes("n")) y1 += dy;
  if (handle.includes("s")) y2 += dy;
  const clamp = (v: number, max: number) => Math.min(Math.max(0, v), max);
  return normalizeRect({ x: clamp(x1, vw), y: clamp(y1, vh) }, { x: clamp(x2, vw), y: clamp(y2, vh) });
}

export const HANDLE_CURSORS: Record<Handle, string> = {
  move: "move",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
};
