let eraseLayer: HTMLCanvasElement | null = null;

import { FONT_STACK, normRect, TEXT_LINE_HEIGHT } from "./geometry";
import { type CssRect, type LineLikeShape, type Point, type Shape } from "./types";

/** Device pixels per canvas unit (live view: dpr; export: natural scale). */
export function pixelRatio(ctx: CanvasRenderingContext2D): number {
  try {
    return Math.abs(ctx.getTransform().a) || 1;
  } catch {
    return 1;
  }
}

/** Pixelate a rect sampled from the natural-size base image. */
export function paintMosaic(
  ctx: CanvasRenderingContext2D,
  base: HTMLImageElement,
  shape: CssRect,
  sampleScaleX: number,
  sampleScaleY: number,
): void {
  const r = normRect(shape);
  if (r.w < 1 || r.h < 1) return;
  const block = 10;
  const tw = Math.max(1, Math.round(r.w / block));
  const th = Math.max(1, Math.round(r.h / block));
  const tiny = document.createElement("canvas");
  tiny.width = tw;
  tiny.height = th;
  const tctx = tiny.getContext("2d");
  if (!tctx) return;
  tctx.drawImage(base, r.x * sampleScaleX, r.y * sampleScaleY, r.w * sampleScaleX, r.h * sampleScaleY, 0, 0, tw, th);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tiny, 0, 0, tw, th, r.x, r.y, r.w, r.h);
  ctx.restore();
}

/** Gaussian-blur a rect of the base image (clipped, no soft edges). */
export function paintBlur(
  ctx: CanvasRenderingContext2D,
  base: HTMLImageElement,
  shape: CssRect,
  sampleScaleX: number,
  sampleScaleY: number,
): void {
  const r = normRect(shape);
  if (r.w < 1 || r.h < 1) return;
  const radius = 8;
  const pad = radius * 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.filter = `blur(${radius * pixelRatio(ctx)}px)`;
  ctx.drawImage(
    base,
    (r.x - pad) * sampleScaleX,
    (r.y - pad) * sampleScaleY,
    (r.w + pad * 2) * sampleScaleX,
    (r.h + pad * 2) * sampleScaleY,
    r.x - pad,
    r.y - pad,
    r.w + pad * 2,
    r.h + pad * 2,
  );
  ctx.restore();
}

export function paintArrow(ctx: CanvasRenderingContext2D, s: LineLikeShape): void {
  const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
  const headLen = Math.max(12, s.lineWidth * 4);
  const spread = Math.PI / 7;
  // Stop the shaft inside the head so wide lines keep a sharp tip.
  const shaftEnd = {
    x: s.x2 - Math.cos(angle) * headLen * 0.6,
    y: s.y2 - Math.sin(angle) * headLen * 0.6,
  };
  ctx.beginPath();
  ctx.moveTo(s.x1, s.y1);
  ctx.lineTo(shaftEnd.x, shaftEnd.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(s.x2, s.y2);
  for (const dir of [-1, 1]) {
    const a = angle + Math.PI + dir * spread;
    ctx.lineTo(s.x2 + headLen * Math.cos(a), s.y2 + headLen * Math.sin(a));
  }
  ctx.closePath();
  ctx.fill();
}

export function paintPolyline(ctx: CanvasRenderingContext2D, pts: Point[]): void {
  if (pts.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  } else if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Paint one shape in canvas CSS-px space (the caller's transform maps it to
 * device pixels). `sampleScaleX`/`sampleScaleY` map CSS px to base-image
 * natural px per axis; a single scale still samples both axes equally.
 */
export function paintShape(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  base: HTMLImageElement | null,
  sampleScaleX: number,
  sampleScaleY: number = sampleScaleX,
): void {
  const target = ctx.canvas as HTMLCanvasElement | undefined;
  if (shape.erase?.length && target?.width && target.height) {
    // Render on a same-size layer, punch the erased strokes out of it, then
    // composite: erasing never reveals or removes the screenshot underneath.
    const layer = (eraseLayer ??= document.createElement("canvas"));
    if (layer.width !== target.width || layer.height !== target.height) {
      layer.width = target.width;
      layer.height = target.height;
    }
    const lctx = layer.getContext("2d");
    if (lctx) {
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.clearRect(0, 0, layer.width, layer.height);
      lctx.setTransform(ctx.getTransform());
      paintShapeBody(lctx, shape, base, sampleScaleX, sampleScaleY);
      lctx.save();
      lctx.globalCompositeOperation = "destination-out";
      lctx.strokeStyle = "#000";
      lctx.fillStyle = "#000";
      lctx.lineCap = "round";
      lctx.lineJoin = "round";
      for (const stroke of shape.erase) {
        lctx.lineWidth = stroke.width;
        paintPolyline(lctx, stroke.pts);
      }
      lctx.restore();
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(layer, 0, 0);
      ctx.restore();
      return;
    }
  }
  paintShapeBody(ctx, shape, base, sampleScaleX, sampleScaleY);
}

export function paintShapeBody(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  base: HTMLImageElement | null,
  sampleScaleX: number,
  sampleScaleY: number,
): void {
  ctx.save();
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  ctx.lineWidth = Math.max(1, shape.lineWidth);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  switch (shape.kind) {
    case "rect": {
      const r = normRect(shape);
      if (shape.filled) ctx.fillRect(r.x, r.y, r.w, r.h);
      else ctx.strokeRect(r.x, r.y, r.w, r.h);
      break;
    }
    case "ellipse": {
      const r = normRect(shape);
      ctx.beginPath();
      ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(0.5, r.w / 2), Math.max(0.5, r.h / 2), 0, 0, Math.PI * 2);
      if (shape.filled) ctx.fill();
      else ctx.stroke();
      break;
    }
    case "line":
      ctx.beginPath();
      ctx.moveTo(shape.x1, shape.y1);
      ctx.lineTo(shape.x2, shape.y2);
      ctx.stroke();
      break;
    case "arrow":
      paintArrow(ctx, shape);
      break;
    case "pen":
      if (shape.filled && shape.pts.length >= 3) {
        // Closed freehand region; the outline keeps thin shapes visible.
        ctx.beginPath();
        ctx.moveTo(shape.pts[0].x, shape.pts[0].y);
        for (let i = 1; i < shape.pts.length; i++) ctx.lineTo(shape.pts[i].x, shape.pts[i].y);
        ctx.closePath();
        ctx.fill("evenodd");
        ctx.stroke();
      } else paintPolyline(ctx, shape.pts);
      break;
    case "highlighter":
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = Math.max(8, shape.lineWidth * 3);
      ctx.lineCap = "square";
      paintPolyline(ctx, shape.pts);
      break;
    case "text":
      ctx.font = `600 ${shape.fontSize}px ${shape.fontFamily ?? FONT_STACK}`;
      ctx.textBaseline = "top";
      // Thin dark outline keeps light colors readable on light content.
      ctx.lineWidth = Math.max(2, shape.fontSize / 8);
      ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
      shape.text.split("\n").forEach((line, index) => {
        const y = shape.y + index * shape.fontSize * TEXT_LINE_HEIGHT;
        ctx.strokeText(line, shape.x, y);
        ctx.fillText(line, shape.x, y);
      });
      break;
    case "mosaic":
      if (base) paintMosaic(ctx, base, shape, sampleScaleX, sampleScaleY);
      break;
    case "blur":
      if (base) paintBlur(ctx, base, shape, sampleScaleX, sampleScaleY);
      break;
    case "number": {
      // Flameshot-style numbered marker: filled circle with a white number.
      const r = Math.max(12, 9 + shape.lineWidth * 1.5);
      ctx.beginPath();
      ctx.arc(shape.x, shape.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = `600 ${Math.max(10, r * 1.1)}px ${FONT_STACK}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(shape.num), shape.x, shape.y + r * 0.06);
      break;
    }
    case "balloon": {
      // Speech balloon: rounded rect with a tail pointing to (tx, ty).
      const b = normRect(shape);
      const radius = Math.min(16, b.w / 4, b.h / 4);
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const angle = Math.atan2(shape.ty - cy, shape.tx - cx);
      const edgeX = cx + Math.cos(angle) * (b.w / 2) * 0.8;
      const edgeY = cy + Math.sin(angle) * (b.h / 2) * 0.8;
      const perp = angle + Math.PI / 2;
      const spread = Math.min(18, b.w / 4, b.h / 4);
      ctx.beginPath();
      ctx.moveTo(shape.tx, shape.ty);
      ctx.lineTo(edgeX + Math.cos(perp) * spread, edgeY + Math.sin(perp) * spread);
      ctx.lineTo(edgeX - Math.cos(perp) * spread, edgeY - Math.sin(perp) * spread);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.roundRect(b.x, b.y, b.w, b.h, radius);
      ctx.fill();
      break;
    }
  }
  ctx.restore();
}
