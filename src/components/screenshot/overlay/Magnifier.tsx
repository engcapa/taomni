import { useEffect, useRef, useState } from "react";

/** Feishu-style magnifier: 120px box, 4x zoom, crosshair, pixel color. */
export function Magnifier({
  img,
  cursor,
  sx,
  sy,
  viewport,
}: {
  img: HTMLImageElement;
  cursor: { x: number; y: number; };
  sx: number;
  sy: number;
  viewport: { w: number; h: number; };
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hex, setHex] = useState("");
  const size = 120;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const zoom = 4;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    const srcW = (size / zoom) * sx;
    const srcH = (size / zoom) * sy;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, cursor.x * sx - srcW / 2, cursor.y * sy - srcH / 2, srcW, srcH, 0, 0, size, size);
    try {
      const px = ctx.getImageData(size / 2, size / 2, 1, 1).data;
      setHex(`#${[px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`);
    } catch {
      setHex("");
    }
    ctx.strokeStyle = "rgba(22, 119, 255, 0.9)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(size / 2 + 0.5, 0);
    ctx.lineTo(size / 2 + 0.5, size);
    ctx.moveTo(0, size / 2 + 0.5);
    ctx.lineTo(size, size / 2 + 0.5);
    ctx.stroke();
  }, [img, cursor, sx, sy]);

  let left = cursor.x + 18;
  let top = cursor.y + 18;
  if (cursor.x > viewport.w - size - 24) left = cursor.x - size - 18;
  if (cursor.y > viewport.h - size - 60) top = cursor.y - size - 54;

  return (
    <div
      data-testid="screenshot-magnifier"
      style={{ position: "fixed", zIndex: 60, left, top, width: size, pointerEvents: "none" }}
    >
      <div
        style={{
          width: size,
          height: size,
          borderRadius: 8,
          overflow: "hidden",
          border: "1px solid rgba(255, 255, 255, 0.65)",
          boxShadow: "0 4px 18px rgba(0, 0, 0, 0.55)",
        }}
      >
        <canvas ref={canvasRef} style={{ display: "block", width: size, height: size }} />
      </div>
      <div
        className="mt-1 rounded px-1.5 py-0.5 text-center font-mono text-[11px]"
        style={{ background: "rgba(0,0,0,0.75)", color: "#fff" }}
      >
        {Math.round(cursor.x * sx)}, {Math.round(cursor.y * sy)} {hex}
      </div>
    </div>
  );
}
