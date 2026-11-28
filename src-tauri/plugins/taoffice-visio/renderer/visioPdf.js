import { PDFDocument } from "@cantoo/pdf-lib";

const MAX_EDGE = 4096;
const MAX_PIXELS = 4 * 1024 * 1024;

// libvisio supplies a viewBox in points. preparePage exposes CSS pixels at 96 dpi.
// Aim for 192 dpi for print comparisons and reject pages that cannot fit at 96 dpi.
function bitmapSize({ width, height }) {
  if (![width, height].every(value => Number.isFinite(value) && value > 0)) throw new Error("pdf-limits");
  const scale = Math.min(2, MAX_EDGE / width, MAX_EDGE / height, Math.sqrt(MAX_PIXELS / (width * height)));
  if (scale < 1) throw new Error("pdf-limits");
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

export async function exportVisioPdf(page) {
  const size = bitmapSize(page);
  const url = URL.createObjectURL(new Blob([page.svg], { type: "image/svg+xml" }));
  const canvas = document.createElement("canvas");
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("pdf-render");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.drawImage(image, 0, 0, size.width, size.height);
    const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    if (!png) throw new Error("pdf-render");
    const pdf = await PDFDocument.create();
    const bitmap = await pdf.embedPng(await png.arrayBuffer());
    const output = pdf.addPage([page.width * 72 / 96, page.height * 72 / 96]);
    output.drawImage(bitmap, { x: 0, y: 0, ...output.getSize() });
    return await pdf.save();
  } finally {
    URL.revokeObjectURL(url);
    canvas.width = canvas.height = 0;
  }
}
