import type { jsPDF } from "jspdf";

interface PdfRgbImage {
  data: string; index: number; alias: string; width: number; height: number;
  colorSpace: "DeviceRGB"; bitsPerComponent: 8; filter: "FlateDecode";
}
function processRgb(data: Uint8Array, index: number, alias: string): PdfRgbImage {
  if (data.byteLength < 9) throw new Error("Invalid compressed PDF image");
  const header = new DataView(data.buffer, data.byteOffset, 8);
  const width = header.getUint32(0), height = header.getUint32(4);
  if (!width || !height || width > 32700 || height > 32700) throw new Error("Invalid PDF image dimensions");
  const bytes = data.subarray(8);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  return { data: binary, index, alias, width, height, colorSpace: "DeviceRGB", bitsPerComponent: 8, filter: "FlateDecode" };
}

/** A pure jsPDF format processor. Dimensions travel with each image, so two
 * simultaneous exports cannot overwrite shared metadata. Register before new
 * jsPDF: its support check reads the constructor API, not the instance API. */
export function registerPdfRgb(Pdf: typeof jsPDF): void {
  (Pdf.API as typeof Pdf.API & { processTAOMNIRGB: typeof processRgb }).processTAOMNIRGB = processRgb;
}

/** The canvas is opaque (page background already painted). Avoid encoding PNG
 * only for jsPDF to decode it and synchronously recompress the same pixels. */
export async function compressedPdfRgb(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("PDF image rendering is unavailable");
  const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const rgb = new Uint8Array(canvas.width * canvas.height * 3);
  for (let input = 0, output = 0; input < rgba.length; input += 4) {
    rgb[output++] = rgba[input]; rgb[output++] = rgba[input + 1]; rgb[output++] = rgba[input + 2];
  }
  const compressed = typeof CompressionStream !== "undefined"
    ? new Uint8Array(await new Response(new Blob([rgb]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer())
    : (await import("fflate")).zlibSync(rgb);
  const packed = new Uint8Array(compressed.length + 8);
  const header = new DataView(packed.buffer);
  header.setUint32(0, canvas.width); header.setUint32(4, canvas.height); packed.set(compressed, 8);
  return packed;
}
