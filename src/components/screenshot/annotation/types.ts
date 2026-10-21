import type { ScreenshotPoint } from "../../../lib/screenshot";

export type AnnotationTool =
  | "select"
  | "move"
  | "rect"
  | "ellipse"
  | "arrow"
  | "line"
  | "pen"
  | "highlighter"
  | "text"
  | "mosaic"
  | "blur"
  | "number"
  | "balloon"
  | "eraser";

export interface CssRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

/** A partial-eraser pass attached to the shape it removed pixels from. */
export interface EraseStroke {
  pts: Point[];
  /** Stroke diameter in canvas CSS px. */
  width: number;
}

export interface ShapeBase {
  id: number;
  color: string;
  lineWidth: number;
  /**
   * Partial erasures. Stored on the shape (not the layer) so moving or
   * resizing the shape keeps exactly the same pixels removed.
   */
  erase?: EraseStroke[];
}

export interface RectLikeShape extends ShapeBase {
  kind: "rect" | "ellipse" | "mosaic" | "blur";
  x: number;
  y: number;
  w: number;
  h: number;
  /** Solid rect / ellipse instead of an outline. */
  filled?: boolean;
}

export interface LineLikeShape extends ShapeBase {
  kind: "line" | "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface PenShape extends ShapeBase {
  kind: "pen" | "highlighter";
  pts: Point[];
  /** Freehand pen closed into a solid region. */
  filled?: boolean;
}

export type EraserMode = "partial" | "object";

/** Tools whose shapes can be drawn solid. */
export const FILLABLE_TOOLS: readonly AnnotationTool[] = ["rect", "ellipse", "pen"];

export interface TextShape extends ShapeBase {
  kind: "text";
  x: number;
  y: number;
  text: string;
  fontSize: number;
  fontFamily?: string;
}

export interface NumberShape extends ShapeBase {
  kind: "number";
  x: number;
  y: number;
  num: number;
}

export interface BalloonShape extends ShapeBase {
  kind: "balloon";
  x: number;
  y: number;
  w: number;
  h: number;
  /** Tail tip position (points to the annotated target). */
  tx: number;
  ty: number;
}

export type Shape = RectLikeShape | LineLikeShape | PenShape | TextShape | NumberShape | BalloonShape;

export interface AnnotationCanvasHandle {
  undo: () => void;
  redo: () => void;
  clear: () => void;
  /**
   * Composite the base image and all shapes at the image's natural size.
   * `sx`/`sy` map canvas CSS px to natural px per axis.
   */
  exportDataUrl: (base: HTMLImageElement, sx: number, sy: number) => string;
  /** Programmatically add shapes (e.g. auto-redact boxes) as one undo step. */
  addShapes: (shapes: Shape[]) => void;
  shapeCount: () => number;
  deleteSelected: () => boolean;
  updateSelectedStyle: (style: ShapeStyle) => void;
  /** Current shapes (image edits bake them and restore them on undo). */
  snapshot: () => Shape[];
  /** Replace all shapes with `shapes` and reset annotation history. */
  restore: (shapes: Shape[]) => void;
}

export interface ShapeStyle {
  color?: string;
  lineWidth?: number;
  fontFamily?: string;
  fontSize?: number;
  filled?: boolean;
}

export interface AnnotationCanvasProps {
  /** CSS-pixel display size of the background image. */
  imageWidth: number;
  imageHeight: number;
  tool: AnnotationTool;
  color: string;
  lineWidth: number;
  fontFamily?: string;
  fontSize?: number;
  textHint?: string;
  /** New rect / ellipse / pen shapes are solid. */
  fill?: boolean;
  /** `partial` removes pixels under the eraser; `object` deletes whole shapes. */
  eraserMode?: EraserMode;
  /** Loaded background image; sampled by mosaic and blur. */
  baseImage: HTMLImageElement | null;
  /** CSS-pixel rect annotations are clipped to; null = whole image. */
  selection: CssRect | null;
  /** Optional closed freehand boundary in the same CSS-pixel space. */
  selectionContour?: readonly ScreenshotPoint[] | null;
  onHistoryChange?: (canUndo: boolean, canRedo: boolean) => void;
  /** Fired when the user presses a draw tool outside the selection. */
  onRequestReselect?: (at: Point) => void;
  onSelectionChange?: (shape: Shape | null) => void;
  /** True while a pointer stroke is in progress (toolbar fades out). */
  onDrawingChange?: (drawing: boolean) => void;
}
