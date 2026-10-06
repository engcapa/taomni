// Pure image helpers for the screenshot tool: tiled watermark placement and
// whole-image edits. Kept free of React and IPC so every rule is
// unit-testable. Pinned-window arrangement lives in the backend
// (src-tauri/src/screenshot/pins.rs) because it spans native windows.

export interface WatermarkSettings {
  text: string;
  /** 0..1 global alpha of each mark. */
  opacity: number;
  color: string;
  /** Mark size relative to the default (`1`). */
  scale?: number;
  /** Fixed seed keeps a preview and its export identical. */
  seed?: number;
}

export interface WatermarkMark {
  x: number;
  y: number;
  /** Radians. */
  angle: number;
}

export interface WatermarkLayout {
  fontSize: number;
  marks: WatermarkMark[];
}

/** Deterministic PRNG (mulberry32) so a seed reproduces the same layout. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Tiled watermark: a staggered grid covering the whole image, each mark
 * jittered and slightly rotated so it reads as scattered rather than a
 * stamp, yet no region (corners included) is left uncovered. Large gaps and
 * a small font keep the screenshot readable. `measure` returns the text
 * width at `fontSize`.
 */
export function watermarkLayout(
  width: number,
  height: number,
  textWidthAt: (fontSize: number) => number,
  seed: number,
  scale = 1,
): WatermarkLayout {
  const shortSide = Math.max(1, Math.min(width, height));
  const fontSize = Math.round(Math.max(12, Math.min(48, shortSide / 22)) * Math.max(0.5, Math.min(2, scale)));
  const textWidth = Math.max(fontSize, textWidthAt(fontSize));
  // Cells are wide enough that marks never touch, so most pixels stay clear.
  const cellW = Math.max(textWidth * 1.9, fontSize * 8);
  const cellH = Math.max(fontSize * 5, textWidth * 0.75);
  const cols = Math.max(1, Math.ceil(width / cellW));
  const rows = Math.max(1, Math.ceil(height / cellH));
  const stepX = width / cols;
  const stepY = height / rows;
  const random = seededRandom(seed);
  const marks: WatermarkMark[] = [];
  for (let r = 0; r < rows; r++) {
    // Alternate rows shift by half a cell; wrap so edges stay covered.
    const offset = r % 2 ? stepX / 2 : 0;
    for (let c = 0; c < cols; c++) {
      const jx = (random() - 0.5) * stepX * 0.4;
      const jy = (random() - 0.5) * stepY * 0.4;
      let x = (c + 0.5) * stepX + offset + jx;
      if (x > width) x -= width;
      const y = (r + 0.5) * stepY + jy;
      const angle = (-20 + (random() - 0.5) * 16) * (Math.PI / 180);
      marks.push({ x, y, angle });
    }
  }
  return { fontSize, marks };
}

/** Paint a tiled watermark over the context's current content. */
export function paintWatermark(ctx: CanvasRenderingContext2D, width: number, height: number, wm: WatermarkSettings): void {
  const font = (size: number) => `600 ${size}px Inter, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;
  const layout = watermarkLayout(width, height, (size) => {
    ctx.font = font(size);
    return ctx.measureText(wm.text)?.width ?? wm.text.length * size * 0.6;
  }, wm.seed ?? 1, wm.scale);
  ctx.save();
  ctx.font = font(layout.fontSize);
  ctx.globalAlpha = Math.max(0.05, Math.min(0.8, wm.opacity));
  ctx.fillStyle = wm.color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // A soft contrasting shadow keeps light and dark marks visible anywhere.
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = Math.max(1, Math.round(layout.fontSize / 8));
  for (const mark of layout.marks) {
    ctx.save();
    ctx.translate(mark.x, mark.y);
    ctx.rotate(mark.angle);
    ctx.fillText(wm.text, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Whole-image edits
// ---------------------------------------------------------------------------

export type ImageEdit =
  | { kind: "rotate"; quarterTurns: 1 | 2 | 3 }
  | { kind: "flip"; axis: "horizontal" | "vertical" }
  | { kind: "resize"; width: number; height: number }
  | { kind: "crop"; x: number; y: number; width: number; height: number }
  | { kind: "adjust"; brightness: number; contrast: number; saturation: number; grayscale: boolean; invert: boolean };

export const NEUTRAL_ADJUST = { brightness: 100, contrast: 100, saturation: 100, grayscale: false, invert: false };

/** Upper bound for a resize target (per axis, physical px). */
export const MAX_RESIZE = 16384;

/** Output size of an edit applied to a `w`x`h` image. */
export function editedSize(w: number, h: number, edit: ImageEdit): { width: number; height: number } {
  switch (edit.kind) {
    case "rotate": return edit.quarterTurns % 2 ? { width: h, height: w } : { width: w, height: h };
    case "crop": return {
      width: Math.max(1, Math.min(w - Math.max(0, edit.x), Math.round(edit.width))),
      height: Math.max(1, Math.min(h - Math.max(0, edit.y), Math.round(edit.height))),
    };
    case "resize": {
      if (![edit.width, edit.height].every((n) => Number.isFinite(n) && n >= 1 && n <= MAX_RESIZE)
        || edit.width * edit.height > 64_000_000) throw new Error("Image dimensions exceed the 64 megapixel limit");
      return { width: Math.round(edit.width), height: Math.round(edit.height) };
    }
    default: return { width: w, height: h };
  }
}

/** CSS filter string for an adjust edit (percentages, 100 = unchanged). */
export function adjustFilter(edit: Extract<ImageEdit, { kind: "adjust" }>): string {
  const parts = [`brightness(${edit.brightness}%)`, `contrast(${edit.contrast}%)`, `saturate(${edit.saturation}%)`];
  if (edit.grayscale) parts.push("grayscale(100%)");
  if (edit.invert) parts.push("invert(100%)");
  return parts.join(" ");
}

/** Whether an adjust edit would leave every pixel unchanged. */
export function isNeutralAdjust(edit: Extract<ImageEdit, { kind: "adjust" }>): boolean {
  return edit.brightness === 100 && edit.contrast === 100 && edit.saturation === 100 && !edit.grayscale && !edit.invert;
}

/**
 * Draw `source` into `ctx` (already sized via [`editedSize`]) with `edit`.
 * Adjustments without a canvas `filter` (older WebKitGTK) fall back to a
 * per-pixel pass so every platform produces the same output.
 */
export function drawEdited(ctx: CanvasRenderingContext2D, source: CanvasImageSource, w: number, h: number, edit: ImageEdit): void {
  const out = editedSize(w, h, edit);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  switch (edit.kind) {
    case "rotate":
      ctx.translate(out.width / 2, out.height / 2);
      ctx.rotate((edit.quarterTurns * Math.PI) / 2);
      ctx.drawImage(source, -w / 2, -h / 2, w, h);
      break;
    case "flip":
      if (edit.axis === "horizontal") { ctx.translate(w, 0); ctx.scale(-1, 1); }
      else { ctx.translate(0, h); ctx.scale(1, -1); }
      ctx.drawImage(source, 0, 0, w, h);
      break;
    case "resize":
      ctx.drawImage(source, 0, 0, out.width, out.height);
      break;
    case "crop":
      ctx.drawImage(source, Math.max(0, edit.x), Math.max(0, edit.y), out.width, out.height, 0, 0, out.width, out.height);
      break;
    case "adjust": {
      // One implementation on WebKitGTK, WKWebView and WebView2: filter
      // availability alone does not guarantee equivalent Canvas rendering.
      ctx.drawImage(source, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h);
      adjustPixels(data.data, edit);
      ctx.putImageData(data, 0, 0);
      break;
    }
  }
  ctx.restore();
}

/** Per-pixel equivalent of [`adjustFilter`] (CSS filter-effects formulas). */
export function adjustPixels(px: Uint8ClampedArray, edit: Extract<ImageEdit, { kind: "adjust" }>): void {
  const b = edit.brightness / 100, c = edit.contrast / 100, s = edit.saturation / 100;
  for (let i = 0; i < px.length; i += 4) {
    let r = px[i] * b, g = px[i + 1] * b, bl = px[i + 2] * b;
    r = (r - 127.5) * c + 127.5; g = (g - 127.5) * c + 127.5; bl = (bl - 127.5) * c + 127.5;
    const sr = 0.213 + 0.787 * s, sg = 0.715 - 0.715 * s, sb = 0.072 - 0.072 * s;
    const nr = r * sr + g * sg + bl * sb;
    const ng = r * (0.213 - 0.213 * s) + g * (0.715 + 0.285 * s) + bl * (0.072 - 0.072 * s);
    const nb = r * (0.213 - 0.213 * s) + g * (0.715 - 0.715 * s) + bl * (0.072 + 0.928 * s);
    r = nr; g = ng; bl = nb;
    if (edit.grayscale) { const y = 0.2126 * r + 0.7152 * g + 0.0722 * bl; r = g = bl = y; }
    if (edit.invert) { r = 255 - r; g = 255 - g; bl = 255 - bl; }
    px[i] = r; px[i + 1] = g; px[i + 2] = bl;
  }
}
