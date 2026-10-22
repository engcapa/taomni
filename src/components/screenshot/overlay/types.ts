import { type ScreenshotPoint } from "../../../lib/screenshot";
import { type CssRect, type Shape } from "../AnnotationCanvas";

export type Phase = "loading" | "select" | "annotate" | "busy" | "preview";

export interface ImageSnapshot {
  img: HTMLImageElement; url: string; selection: CssRect | null; contour: ScreenshotPoint[] | null;
  result: { frames: number; w: number; h: number; } | null; shapes: Shape[];
}

export type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
