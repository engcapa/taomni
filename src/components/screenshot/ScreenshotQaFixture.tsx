import { useEffect, useRef } from "react";

interface SourceFrame {
  id: number;
  atMs: number;
  dataUrl: string;
}

interface SourceEvidence {
  kind: "scroll" | "anim";
  cssWidth: number;
  cssHeight: number;
  width: number;
  height: number;
  scale: number;
  nonce: number;
  frames: SourceFrame[];
  dataUrl?: string;
}

declare global {
  interface Window {
    __qaScreenshotSource?: SourceEvidence;
  }
}

/**
 * Native QA renders ordinary canvas content and retains its original pixels.
 * Capture/scroll/record still read the OS screen; nothing is inserted into the
 * capture or encoder path. Original canvas PNGs are an independent content
 * oracle, not native evidence by themselves.
 */
export function ScreenshotQaFixture({ route }: { route: string }) {
  if (route === "ocr") return <OcrFixture />;
  return <PixelFixture animated={route === "anim"} />;
}

const ROWS = 32;

function rowColor(i: number): string {
  return `rgb(${30 + (i % 8) * 28}, ${30 + Math.floor(i / 8) * 28}, 210)`;
}

/** Complementary black/white rows make a damaged or wrong code rejectable. */
function paintCode(ctx: CanvasRenderingContext2D, value: number, bits: number, y: number) {
  for (let bit = 0; bit < bits; bit++) {
    const set = !!(value & (1 << bit));
    ctx.fillStyle = set ? "#f4f4f4" : "#080808";
    ctx.fillRect(20 + bit * 12, y, 10, 10);
    ctx.fillStyle = set ? "#080808" : "#f4f4f4";
    ctx.fillRect(20 + bit * 12, y + 14, 10, 10);
  }
}

function paintPage(ctx: CanvasRenderingContext2D, width: number) {
  for (let i = 0; i < ROWS; i++) {
    const y = i * 48;
    ctx.fillStyle = rowColor(i);
    ctx.fillRect(0, y, width, 44);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, y + 44, width, 4);
    ctx.font = "600 14px sans-serif";
    ctx.fillText(`Row ${i} / original page`, 12, y + 27);
    // Different horizontal content tests more than one colored decode column:
    // small text, checker cells, alternating bars and a sloped edge.
    for (let j = 0; j < 12; j++) {
      ctx.fillStyle = ((i * 7 + j * 3) % 5) < 2 ? "#101820" : "#f8e9a1";
      ctx.fillRect(width * 0.4 + j * 8, y + 7 + ((i + j) % 3), 6, 28 - ((i * 3 + j) % 11));
    }
    ctx.fillStyle = "#ff5a32";
    ctx.beginPath();
    ctx.moveTo(width * 0.86, y + 4);
    ctx.lineTo(width * 0.95, y + 10 + (i % 4) * 7);
    ctx.lineTo(width * 0.86, y + 40);
    ctx.fill();
  }
}

function paintAnimation(ctx: CanvasRenderingContext2D, width: number, height: number, id: number, nonce: number) {
  ctx.fillStyle = `hsl(${(id * 4) % 360}, 45%, 30%)`;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 28px monospace";
  ctx.fillText(`frame ${id}`, 20, 40);
  paintCode(ctx, id, 12, 64);
  paintCode(ctx, nonce, 16, 112);
  ctx.fillStyle = "#ff3030";
  ctx.fillRect(20 + (id * 9) % Math.max(1, width - 110), 168, 80, 80);
  ctx.fillStyle = "#36b8f1";
  ctx.fillRect(width - 90, 260 + (id * 5) % Math.max(1, height - 310), 54, 30);
  ctx.fillStyle = "#ffffff";
  ctx.font = "600 16px sans-serif";
  ctx.fillText(`source ${nonce}`, 20, height - 20);
  for (let i = 0; i < 16; i++) {
    ctx.fillStyle = ((nonce >> (i % 16)) ^ id ^ i) & 1 ? "#f8e9a1" : "#101820";
    ctx.fillRect(20 + i * 12, height - 62, 8, 18 + (i % 3) * 3);
  }
}

function PixelFixture({ animated }: { animated: boolean }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // WebKit's overlay scrollbar can cover pixels without reducing clientWidth.
    // Keep its entire gutter outside both the drawn canvas and capture region.
    const width = root.clientWidth - (animated ? 0 : 8);
    const height = animated ? root.clientHeight : ROWS * 48;
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    // Publish the frame id and moving shapes from one completed buffer.
    // Retained originals describe complete scenes for native pixel comparison.
    const frameCanvas = document.createElement("canvas");
    frameCanvas.width = canvas.width;
    frameCanvas.height = canvas.height;
    const frameCtx = frameCanvas.getContext("2d");
    if (!frameCtx) return;
    const nonce = crypto.getRandomValues(new Uint16Array(1))[0] || 1;
    const source: SourceEvidence = {
      kind: animated ? "anim" : "scroll", cssWidth: width, cssHeight: height,
      width: canvas.width, height: canvas.height, scale, nonce, frames: [],
    };
    window.__qaScreenshotSource = source;
    let id = 0;
    const draw = () => {
      frameCtx.setTransform(scale, 0, 0, scale, 0, 0);
      if (animated) paintAnimation(frameCtx, width, height, id, nonce);
      else paintPage(frameCtx, width);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(frameCanvas, 0, 0);
      const dataUrl = canvas.toDataURL("image/png");
      if (animated) {
        source.frames.push({ id, atMs: performance.now(), dataUrl });
        // Bounded originals from actual draw calls, never reconstructed later.
        if (source.frames.length > 240) source.frames.shift();
      } else source.dataUrl = dataUrl;
      canvas.dataset.sourceId = String(id++);
      root.dataset.sourceReady = "true";
    };
    draw();
    const timer = animated ? window.setInterval(draw, 50) : undefined;
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      if (window.__qaScreenshotSource === source) delete window.__qaScreenshotSource;
    };
  }, [animated]);
  return (
    // Keep the native scene consistent with the retained canvas original while
    // real OS wheel input moves the pointer through the fixture.
    <div ref={rootRef} data-testid="screenshot-qa-fixture-ready" style={{ position: "fixed", inset: 0, paddingRight: animated ? 0 : 8, overflowY: animated ? "hidden" : "scroll", background: "#ffffff", scrollBehavior: "auto", cursor: "none" }}>
      <canvas ref={canvasRef} style={{ display: "block" }} />
    </div>
  );
}

function OcrFixture() {
  return (
    <div data-testid="screenshot-qa-fixture-ready" style={{ position: "fixed", inset: 0, background: "#ffffff", color: "#000000", padding: 24, font: "28px Arial, sans-serif" }}>
      <p style={{ margin: "12px 0 28px" }}>QA screenshot text</p>
      <p style={{ margin: "12px 0 28px" }}>user@example.com</p>
      <p style={{ margin: "12px 0 28px" }}>13812345678</p>
      <p style={{ margin: "12px 0 28px" }}>2026-10-02</p>
    </div>
  );
}
