// Shared capture utilities — screenshot (visible + full scrollback) and GIF
// recording — used by terminal, SSH, and VNC tabs.
//
// Design notes:
//   * For canvas-backed views (VNC), we compose visible canvases inside the
//     container into a single PNG/Blob.
//   * For DOM-backed views (xterm with WebGL or DOM renderer), screenshotting
//     the layered canvases directly is fragile across renderer versions; we
//     instead render the active buffer to a 2D canvas using the resolved
//     theme, which works uniformly for visible + full scrollback.
//   * GIF encoding is delegated to gif.js running in a Web Worker.

import type { Terminal, IBufferLine, IBufferCell } from "@xterm/xterm";

import {
  type GifRecorderOptions,
  type GifRecorder,
  createGifRecorder,
} from "./gifRecorder";

import { writeImagePng } from "../clipboard";
import {
  selectSaveFilePath,
  writeStreamOpen,
  writeStreamAppend,
  writeStreamClose,
  writeStreamAbort,
} from "../ipc";

// ── Source helpers ──────────────────────────────────────────────────────

/** Snapshot a single canvas (e.g. VNC) to a PNG blob. */
export async function captureCanvasPng(
  canvas: HTMLCanvasElement,
): Promise<Blob> {
  return await canvasToBlob(canvas);
}

/** Compose every <canvas> child of a container into one PNG. */
export async function captureContainerCanvasesPng(
  container: HTMLElement,
): Promise<Blob> {
  const canvases = Array.from(container.querySelectorAll("canvas"));
  if (canvases.length === 0) {
    throw new Error("No canvas to capture");
  }
  if (canvases.length === 1) {
    return captureCanvasPng(canvases[0]);
  }
  const baseRect = container.getBoundingClientRect();
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(baseRect.width));
  out.height = Math.max(1, Math.round(baseRect.height));
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");
  for (const c of canvases) {
    const r = c.getBoundingClientRect();
    ctx.drawImage(
      c,
      r.left - baseRect.left,
      r.top - baseRect.top,
      r.width,
      r.height,
    );
  }
  return await canvasToBlob(out);
}

/** Capture a DOM element to PNG using an SVG foreignObject snapshot.
 *  This is intended for regular DOM surfaces such as database grids. Canvas-
 *  backed views should keep using their dedicated capture paths. */
export async function captureElementPng(element: HTMLElement): Promise<Blob> {
  return await canvasToBlob(await renderElementToCanvas(element));
}

/** Render a DOM element to a canvas frame, useful for visible screenshots,
 *  manual scroll capture, and GIF frame sources. */
export async function renderElementToCanvas(element: HTMLElement): Promise<HTMLCanvasElement> {
  try {
    const canvas = await renderElementToCanvasViaSvg(element);
    assertCanvasReadable(canvas);
    return canvas;
  } catch {
    // WebView2 can taint SVG foreignObject snapshots, which blocks toBlob().
    return await renderElementToCanvasBasic(element);
  }
}

function renderElementToCanvasViaSvg(element: HTMLElement): Promise<HTMLCanvasElement> {
  const rect = element.getBoundingClientRect();
  const width = Math.max(1, Math.ceil(rect.width));
  const height = Math.max(1, Math.ceil(rect.height));
  const clone = element.cloneNode(true) as HTMLElement;
  clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  inlineComputedStyles(element, clone);
  clone.style.width = `${width}px`;
  clone.style.height = `${height}px`;
  clone.style.margin = "0";
  clone.style.transform = "none";

  const markup = new XMLSerializer().serializeToString(clone);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<foreignObject width="100%" height="100%">${markup}</foreignObject>`,
    "</svg>",
  ].join("");
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  return (async () => {
    const image = await loadImage(url);
    const canvas = document.createElement("canvas");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable");
    ctx.scale(dpr, dpr);
    ctx.fillStyle = resolvedBackground(element);
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    return canvas;
  })().finally(() => {
    URL.revokeObjectURL(url);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to render DOM snapshot"));
    image.src = url;
  });
}

function inlineComputedStyles(source: Element, target: Element): void {
  if (target instanceof HTMLElement || target instanceof SVGElement) {
    const computed = window.getComputedStyle(source);
    const style = (target as HTMLElement | SVGElement).style;
    for (let i = 0; i < computed.length; i += 1) {
      const property = computed.item(i);
      style.setProperty(property, computed.getPropertyValue(property), computed.getPropertyPriority(property));
    }
  }

  if (source instanceof HTMLInputElement && target instanceof HTMLInputElement) {
    target.setAttribute("value", source.value);
    if (source.checked) target.setAttribute("checked", "checked");
  } else if (source instanceof HTMLTextAreaElement && target instanceof HTMLTextAreaElement) {
    target.textContent = source.value;
  } else if (source instanceof HTMLSelectElement && target instanceof HTMLSelectElement) {
    target.value = source.value;
    Array.from(target.options).forEach((option) => {
      if (option.value === source.value) option.setAttribute("selected", "selected");
      else option.removeAttribute("selected");
    });
  }

  const sourceChildren = Array.from(source.children);
  const targetChildren = Array.from(target.children);
  for (let i = 0; i < sourceChildren.length; i += 1) {
    if (targetChildren[i]) inlineComputedStyles(sourceChildren[i], targetChildren[i]);
  }
}

function resolvedBackground(element: HTMLElement): string {
  let cursor: HTMLElement | null = element;
  while (cursor) {
    const color = window.getComputedStyle(cursor).backgroundColor;
    if (color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent") return color;
    cursor = cursor.parentElement;
  }
  return "#ffffff";
}

async function renderElementToCanvasBasic(element: HTMLElement): Promise<HTMLCanvasElement> {
  try {
    await document.fonts?.ready;
  } catch {
    /* Font readiness is best-effort for capture fallback. */
  }

  const rect = element.getBoundingClientRect();
  const width = Math.max(1, Math.ceil(rect.width));
  const height = Math.max(1, Math.ceil(rect.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");
  ctx.scale(dpr, dpr);
  ctx.fillStyle = resolvedBackground(element);
  ctx.fillRect(0, 0, width, height);
  drawDomNodeToCanvas(element, ctx, rect);
  assertCanvasReadable(canvas);
  return canvas;
}

function drawDomNodeToCanvas(
  node: Node,
  ctx: CanvasRenderingContext2D,
  rootRect: DOMRect,
): void {
  if (node.nodeType === Node.TEXT_NODE) {
    drawTextNodeToCanvas(node, ctx, rootRect);
    return;
  }
  if (!(node instanceof Element)) return;
  if (node instanceof SVGElement) return;

  const style = window.getComputedStyle(node);
  if (style.display === "none" || style.visibility === "hidden") return;

  const rect = node.getBoundingClientRect();
  if (!rectIntersectsRoot(rect, rootRect)) return;

  ctx.save();
  const opacity = Number(style.opacity);
  if (Number.isFinite(opacity)) ctx.globalAlpha *= Math.max(0, Math.min(1, opacity));

  drawElementBox(ctx, rect, rootRect, style);

  const clipsOverflow =
    style.overflow !== "visible" ||
    style.overflowX !== "visible" ||
    style.overflowY !== "visible";
  if (clipsOverflow) {
    clipRect(ctx, rect, rootRect);
  }

  drawFormControlValue(ctx, node, rect, rootRect, style);

  node.childNodes.forEach((child) => drawDomNodeToCanvas(child, ctx, rootRect));
  ctx.restore();
}

function drawTextNodeToCanvas(
  node: Node,
  ctx: CanvasRenderingContext2D,
  rootRect: DOMRect,
): void {
  const raw = node.textContent ?? "";
  if (!raw.trim()) return;
  const parent = node.parentElement;
  if (!parent) return;
  const style = window.getComputedStyle(parent);
  if (style.display === "none" || style.visibility === "hidden" || colorIsTransparent(style.color)) return;

  const range = document.createRange();
  range.selectNodeContents(node);
  const text = raw.replace(/\s+/g, " ");
  ctx.save();
  ctx.font = canvasFont(style);
  ctx.fillStyle = style.color;
  ctx.textBaseline = "alphabetic";
  for (const rect of Array.from(range.getClientRects())) {
    if (!rectIntersectsRoot(rect, rootRect)) continue;
    const fontSize = parseCssPx(style.fontSize, 12);
    const x = rect.left - rootRect.left;
    const baseline = rect.top - rootRect.top + (rect.height + fontSize) / 2 - fontSize * 0.12;
    ctx.fillText(text, x, baseline, Math.max(1, rect.width));
  }
  ctx.restore();
  range.detach();
}

function drawElementBox(
  ctx: CanvasRenderingContext2D,
  rect: DOMRect,
  rootRect: DOMRect,
  style: CSSStyleDeclaration,
): void {
  const x = rect.left - rootRect.left;
  const y = rect.top - rootRect.top;
  const width = rect.width;
  const height = rect.height;
  if (width <= 0 || height <= 0) return;

  if (!colorIsTransparent(style.backgroundColor)) {
    ctx.fillStyle = style.backgroundColor;
    ctx.fillRect(x, y, width, height);
  }

  drawBorderSide(ctx, x, y, width, parseCssPx(style.borderTopWidth), style.borderTopColor, "top");
  drawBorderSide(ctx, x + width, y, height, parseCssPx(style.borderRightWidth), style.borderRightColor, "right");
  drawBorderSide(ctx, x, y + height, width, parseCssPx(style.borderBottomWidth), style.borderBottomColor, "bottom");
  drawBorderSide(ctx, x, y, height, parseCssPx(style.borderLeftWidth), style.borderLeftColor, "left");
}

function drawBorderSide(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  length: number,
  width: number,
  color: string,
  side: "top" | "right" | "bottom" | "left",
): void {
  if (width <= 0 || colorIsTransparent(color)) return;
  ctx.fillStyle = color;
  switch (side) {
    case "top":
      ctx.fillRect(x, y, length, width);
      break;
    case "right":
      ctx.fillRect(x - width, y, width, length);
      break;
    case "bottom":
      ctx.fillRect(x, y - width, length, width);
      break;
    case "left":
      ctx.fillRect(x, y, width, length);
      break;
  }
}

function drawFormControlValue(
  ctx: CanvasRenderingContext2D,
  node: Element,
  rect: DOMRect,
  rootRect: DOMRect,
  style: CSSStyleDeclaration,
): void {
  let text = "";
  if (node instanceof HTMLInputElement) {
    if (node.type === "checkbox" || node.type === "radio") {
      drawCheckControl(ctx, node.checked, rect, rootRect, style);
      return;
    }
    text = node.value;
  } else if (node instanceof HTMLTextAreaElement) {
    text = node.value;
  } else if (node instanceof HTMLSelectElement) {
    text = node.selectedOptions[0]?.textContent ?? node.value;
  }
  if (!text || colorIsTransparent(style.color)) return;

  const x = rect.left - rootRect.left + parseCssPx(style.paddingLeft, 2);
  const y = rect.top - rootRect.top;
  const fontSize = parseCssPx(style.fontSize, 12);
  const lineHeight = parseCssPx(style.lineHeight, Math.max(fontSize, rect.height));
  const baseline = y + Math.min(rect.height, lineHeight) / 2 + fontSize * 0.36;
  const maxWidth = Math.max(1, rect.width - parseCssPx(style.paddingLeft, 2) - parseCssPx(style.paddingRight, 2));
  ctx.save();
  ctx.font = canvasFont(style);
  ctx.fillStyle = style.color;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, x, baseline, maxWidth);
  ctx.restore();
}

function drawCheckControl(
  ctx: CanvasRenderingContext2D,
  checked: boolean,
  rect: DOMRect,
  rootRect: DOMRect,
  style: CSSStyleDeclaration,
): void {
  const size = Math.max(8, Math.min(rect.width, rect.height));
  const x = rect.left - rootRect.left + (rect.width - size) / 2;
  const y = rect.top - rootRect.top + (rect.height - size) / 2;
  ctx.save();
  ctx.strokeStyle = colorIsTransparent(style.borderTopColor) ? style.color : style.borderTopColor;
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, size, size);
  if (checked) {
    ctx.strokeStyle = style.color;
    ctx.beginPath();
    ctx.moveTo(x + size * 0.22, y + size * 0.52);
    ctx.lineTo(x + size * 0.42, y + size * 0.72);
    ctx.lineTo(x + size * 0.78, y + size * 0.28);
    ctx.stroke();
  }
  ctx.restore();
}

function canvasFont(style: CSSStyleDeclaration): string {
  const fontStyle = style.fontStyle && style.fontStyle !== "normal" ? `${style.fontStyle} ` : "";
  const fontVariant = style.fontVariant && style.fontVariant !== "normal" ? `${style.fontVariant} ` : "";
  const fontWeight = style.fontWeight && style.fontWeight !== "normal" ? `${style.fontWeight} ` : "";
  const fontSize = style.fontSize || "12px";
  const fontFamily = style.fontFamily || "sans-serif";
  return `${fontStyle}${fontVariant}${fontWeight}${fontSize} ${fontFamily}`;
}

function clipRect(ctx: CanvasRenderingContext2D, rect: DOMRect, rootRect: DOMRect): void {
  ctx.beginPath();
  ctx.rect(rect.left - rootRect.left, rect.top - rootRect.top, rect.width, rect.height);
  ctx.clip();
}

function rectIntersectsRoot(rect: DOMRect, rootRect: DOMRect): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > rootRect.left &&
    rect.bottom > rootRect.top &&
    rect.left < rootRect.right &&
    rect.top < rootRect.bottom
  );
}

function colorIsTransparent(color: string): boolean {
  if (!color || color === "transparent") return true;
  const compact = color.replace(/\s+/g, "").toLowerCase();
  const rgba = compact.match(/^rgba\([^,]+,[^,]+,[^,]+,([^)]+)\)$/);
  if (rgba) return Number.parseFloat(rgba[1]) === 0;
  const slashAlpha = compact.match(/^rgb\([^)]+\/([^)]+)\)$/);
  if (slashAlpha) return Number.parseFloat(slashAlpha[1]) === 0;
  return false;
}

function parseCssPx(value: string, fallback = 0): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function assertCanvasReadable(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");
  ctx.getImageData(0, 0, 1, 1);
}

// ── Xterm rendering ────────────────────────────────────────────────────

export interface XtermCaptureTheme {
  background: string;
  foreground: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  palette?: Partial<Record<number, string>>;
}

const DEFAULT_PALETTE: Record<number, string> = {
  0: "#000000",
  1: "#cd0000",
  2: "#00cd00",
  3: "#cdcd00",
  4: "#0000ee",
  5: "#cd00cd",
  6: "#00cdcd",
  7: "#e5e5e5",
  8: "#7f7f7f",
  9: "#ff0000",
  10: "#00ff00",
  11: "#ffff00",
  12: "#5c5cff",
  13: "#ff00ff",
  14: "#00ffff",
  15: "#ffffff",
};

function ansi256(idx: number): string {
  if (idx < 16) return DEFAULT_PALETTE[idx] ?? "#ffffff";
  if (idx >= 232) {
    const v = (idx - 232) * 10 + 8;
    return `rgb(${v},${v},${v})`;
  }
  const i = idx - 16;
  const r = Math.floor(i / 36) % 6;
  const g = Math.floor(i / 6) % 6;
  const b = i % 6;
  const conv = (n: number) => (n === 0 ? 0 : n * 40 + 55);
  return `rgb(${conv(r)},${conv(g)},${conv(b)})`;
}

function fgColor(cell: IBufferCell, theme: XtermCaptureTheme): string {
  if (cell.isFgRGB()) {
    const c = cell.getFgColor();
    return `rgb(${(c >> 16) & 0xff},${(c >> 8) & 0xff},${c & 0xff})`;
  }
  if (cell.isFgPalette()) {
    const idx = cell.getFgColor();
    return theme.palette?.[idx] ?? ansi256(idx);
  }
  return theme.foreground;
}

function bgColor(cell: IBufferCell, theme: XtermCaptureTheme): string | null {
  if (cell.isBgRGB()) {
    const c = cell.getBgColor();
    return `rgb(${(c >> 16) & 0xff},${(c >> 8) & 0xff},${c & 0xff})`;
  }
  if (cell.isBgPalette()) {
    const idx = cell.getBgColor();
    return theme.palette?.[idx] ?? ansi256(idx);
  }
  return null;
}

function renderXtermBuffer(
  term: Terminal,
  theme: XtermCaptureTheme,
  startLine: number,
  endLineExclusive: number,
): HTMLCanvasElement {
  const buffer = term.buffer.active;
  const cols = term.cols;
  const lineCount = Math.max(0, endLineExclusive - startLine);
  // Estimate cell width by measuring a representative glyph at the chosen
  // font size. Monospace fonts make every cell the same width.
  const measureCanvas = document.createElement("canvas");
  const measureCtx = measureCanvas.getContext("2d");
  if (!measureCtx) throw new Error("2D context unavailable");
  measureCtx.font = `${theme.fontSize}px ${theme.fontFamily}`;
  const cellWidth = Math.max(1, Math.ceil(measureCtx.measureText("M").width));
  const cellHeight = Math.max(1, Math.round(theme.fontSize * theme.lineHeight));

  const out = document.createElement("canvas");
  // High-DPI: render at 2× to keep text sharp on hidpi screens, but bound the
  // total area so a 100k-line scrollback doesn't OOM the GPU.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = cols * cellWidth;
  const height = lineCount * cellHeight;
  out.width = Math.max(1, Math.round(width * dpr));
  out.height = Math.max(1, Math.round(height * dpr));
  out.style.width = `${width}px`;
  out.style.height = `${height}px`;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");
  ctx.scale(dpr, dpr);
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = "alphabetic";
  ctx.font = `${theme.fontSize}px ${theme.fontFamily}`;

  const tmpCell = (buffer.getLine(0)?.getCell(0) ?? null) as IBufferCell | null;
  if (!tmpCell) return out;

  for (let row = 0; row < lineCount; row++) {
    const line: IBufferLine | undefined = buffer.getLine(startLine + row);
    if (!line) continue;
    const y = row * cellHeight;
    const baseline = y + theme.fontSize;
    for (let col = 0; col < cols; col++) {
      const cell = line.getCell(col, tmpCell);
      if (!cell) continue;
      const chars = cell.getChars();
      const bg = bgColor(cell, theme);
      if (bg) {
        ctx.fillStyle = bg;
        ctx.fillRect(col * cellWidth, y, cellWidth, cellHeight);
      }
      if (!chars) continue;
      ctx.fillStyle = fgColor(cell, theme);
      const bold = cell.isBold();
      const italic = cell.isItalic();
      const variant =
        (bold ? "bold " : "") + (italic ? "italic " : "");
      ctx.font = `${variant}${theme.fontSize}px ${theme.fontFamily}`;
      ctx.fillText(chars, col * cellWidth, baseline);
      if (cell.isUnderline()) {
        ctx.fillRect(col * cellWidth, baseline + 2, cellWidth, 1);
      }
    }
  }
  return out;
}

/** Capture only the visible viewport of an xterm. */
export async function captureXtermVisible(
  term: Terminal,
  theme: XtermCaptureTheme,
): Promise<Blob> {
  const canvas = renderXtermVisibleToCanvas(term, theme);
  return await canvasToBlob(canvas);
}

/** Render the visible viewport of an xterm to a fresh 2D canvas. Useful as
 *  a frame source for scroll capture / GIF recording — xterm's WebGL canvas
 *  is created without preserveDrawingBuffer, so reading it via drawImage
 *  often yields blanks. */
export function renderXtermVisibleToCanvas(
  term: Terminal,
  theme: XtermCaptureTheme,
): HTMLCanvasElement {
  const buffer = term.buffer.active;
  const start = buffer.viewportY;
  const end = Math.min(buffer.length, start + term.rows);
  return renderXtermBuffer(term, theme, start, end);
}

/** Capture the full active buffer (scrollback + screen). */
export async function captureXtermFullBuffer(
  term: Terminal,
  theme: XtermCaptureTheme,
): Promise<Blob> {
  const buffer = term.buffer.active;
  const canvas = renderXtermBuffer(term, theme, 0, buffer.length);
  return await canvasToBlob(canvas);
}

async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("canvas.toBlob returned null"));
    }, "image/png");
  });
}

// ── Output helpers ──────────────────────────────────────────────────────

/** Save a blob via the native "Save as" dialog. Returns the chosen path
 *  on success, null when the user cancels. Throws on write errors. */
export async function saveBlobToFile(
  blob: Blob,
  defaultName: string,
): Promise<string | null> {
  const path = await selectSaveFilePath(defaultName);
  if (!path) return null;
  await writeBlobToPath(blob, path);
  return path;
}

async function writeBlobToPath(blob: Blob, path: string): Promise<void> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const handleId = await writeStreamOpen(path);
  try {
    const chunkSize = 256 * 1024;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      await writeStreamAppend(handleId, bytes.subarray(offset, end));
    }
    await writeStreamClose(handleId);
  } catch (err) {
    try {
      await writeStreamAbort(handleId);
    } catch {
      /* best-effort */
    }
    throw err;
  }
}

/** Write a PNG blob to the system clipboard. */
export async function copyImageBlobToClipboard(blob: Blob): Promise<void> {
  await writeImagePng(blob);
}

export function timestampFilePart(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function safeFilePart(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "capture"
  );
}

// ── GIF re-export ───────────────────────────────────────────────────────

export type { GifRecorderOptions, GifRecorder };
export { createGifRecorder };

// ── Scroll capture ──────────────────────────────────────────────────────
//
// Long screenshot ("scrolling screenshot") flow: while capture is active we
// poll a frame source for the current viewport; each new frame is appended
// to an accumulator, with the largest pixel-equal prefix between the bottom
// of the accumulator and the top of the new frame removed so consecutive
// scrolls don't duplicate the overlapping region.

export interface ScrollCaptureOptions {
  /** Producer of the next viewport frame. */
  getFrame: () => Promise<CanvasImageSource | null> | CanvasImageSource | null;
  /** Polling interval in ms. Default 250. */
  intervalMs?: number;
  /** Max rows of overlap to search when stitching. Default 256. */
  maxOverlap?: number;
  /** Soft cap on output height in pixels to avoid runaway memory. */
  maxHeight?: number;
  onProgress?: (info: { frames: number; height: number }) => void;
}

export interface ScrollCapture {
  stop: () => Promise<Blob>;
  isRunning: () => boolean;
}

export function startScrollCapture(opts: ScrollCaptureOptions): ScrollCapture {
  const intervalMs = Math.max(100, opts.intervalMs ?? 250);
  const maxOverlap = Math.max(8, opts.maxOverlap ?? 256);
  const maxHeight = opts.maxHeight ?? 32768;
  let acc: HTMLCanvasElement | null = null;
  let lastTopRow: Uint8ClampedArray | null = null;
  let frames = 0;
  let running = true;
  let busy = false;
  let stopResolve: ((blob: Blob) => void) | null = null;
  let stopReject: ((err: unknown) => void) | null = null;

  async function tick(): Promise<void> {
    if (!running || busy) return;
    busy = true;
    try {
      const frame = await opts.getFrame();
      if (!frame) return;
      const w =
        (frame as HTMLCanvasElement).width ??
        (frame as HTMLImageElement).naturalWidth ??
        0;
      const h =
        (frame as HTMLCanvasElement).height ??
        (frame as HTMLImageElement).naturalHeight ??
        0;
      if (!w || !h) return;

      // Materialize the new frame as a 2D canvas so we can read its pixels.
      const frameCanvas = document.createElement("canvas");
      frameCanvas.width = w;
      frameCanvas.height = h;
      const frameCtx = frameCanvas.getContext("2d");
      if (!frameCtx) return;
      frameCtx.drawImage(frame, 0, 0);
      const frameTopRow = readRow(frameCtx, 0);

      if (!acc) {
        acc = document.createElement("canvas");
        acc.width = w;
        acc.height = h;
        const accCtx = acc.getContext("2d");
        if (!accCtx) return;
        accCtx.drawImage(frameCanvas, 0, 0);
        lastTopRow = frameTopRow;
        frames = 1;
        opts.onProgress?.({ frames, height: h });
        return;
      }

      // If the very first row of the new frame is identical to the previous
      // first row, the user hasn't scrolled — skip.
      if (lastTopRow && rowsEqual(lastTopRow, frameTopRow)) {
        return;
      }

      // Find the longest prefix of `frameCanvas` that already exists at the
      // bottom of `acc`. We compare row-by-row.
      const overlap = findOverlap(acc, frameCanvas, maxOverlap);
      const newRows = h - overlap;
      if (newRows <= 0) {
        lastTopRow = frameTopRow;
        return;
      }
      if (acc.height + newRows > maxHeight) {
        // Refuse to grow beyond budget; drop excess.
        running = false;
      }
      const next = document.createElement("canvas");
      next.width = Math.max(acc.width, w);
      next.height = Math.min(acc.height + newRows, maxHeight);
      const ctx = next.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(acc, 0, 0);
      ctx.drawImage(
        frameCanvas,
        0,
        overlap,
        w,
        newRows,
        0,
        acc.height,
        w,
        Math.min(newRows, next.height - acc.height),
      );
      acc = next;
      lastTopRow = frameTopRow;
      frames++;
      opts.onProgress?.({ frames, height: acc.height });
    } finally {
      busy = false;
    }
  }

  const timer = window.setInterval(() => {
    void tick();
  }, intervalMs);

  async function stop(): Promise<Blob> {
    running = false;
    window.clearInterval(timer);
    let waits = 0;
    while (busy && waits < 50) {
      await new Promise((r) => setTimeout(r, 20));
      waits++;
    }
    if (!acc) {
      const empty = new Blob([], { type: "image/png" });
      stopResolve?.(empty);
      return empty;
    }
    const blob = await canvasToBlob(acc);
    stopResolve?.(blob);
    return blob;
  }

  return {
    stop() {
      return new Promise<Blob>((resolve, reject) => {
        stopResolve = resolve;
        stopReject = reject;
        void stop().catch((err) => stopReject?.(err));
      });
    },
    isRunning: () => running,
  };
}

function readRow(ctx: CanvasRenderingContext2D, y: number): Uint8ClampedArray {
  return ctx.getImageData(0, y, ctx.canvas.width, 1).data;
}

function rowsEqual(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function findOverlap(
  acc: HTMLCanvasElement,
  frame: HTMLCanvasElement,
  maxRows: number,
): number {
  const accCtx = acc.getContext("2d");
  const frameCtx = frame.getContext("2d");
  if (!accCtx || !frameCtx) return 0;
  if (acc.width !== frame.width) return 0;

  const width = acc.width;
  const limit = Math.min(maxRows, acc.height, frame.height);
  if (limit === 0) return 0;

  // One getImageData per side, then row-by-row compare.
  const accBottom = accCtx.getImageData(0, acc.height - limit, width, limit).data;
  const frameTop = frameCtx.getImageData(0, 0, width, limit).data;
  const rowBytes = width * 4;

  // Try the largest possible overlap first; fall back to smaller.
  for (let overlap = limit; overlap >= 1; overlap--) {
    const accStart = (limit - overlap) * rowBytes;
    let match = true;
    for (let y = 0; y < overlap && match; y++) {
      const a = accStart + y * rowBytes;
      const b = y * rowBytes;
      for (let i = 0; i < rowBytes; i++) {
        if (accBottom[a + i] !== frameTop[b + i]) {
          match = false;
          break;
        }
      }
    }
    if (match) return overlap;
  }
  return 0;
}
