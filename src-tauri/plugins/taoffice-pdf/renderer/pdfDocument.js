import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";

export function openPdf(data) {
  const assets = new URL(/* @vite-ignore */ "./pdfjs/", import.meta.url);
  GlobalWorkerOptions.workerSrc = new URL("pdf.worker.mjs", assets).href;
  return getDocument({
    data,
    cMapUrl: new URL("cmaps/", assets).href,
    cMapPacked: true,
    standardFontDataUrl: new URL("standard_fonts/", assets).href,
    wasmUrl: new URL("wasm/", assets).href,
    iccUrl: new URL("iccs/", assets).href,
    enableXfa: false,
    maxImageSize: 32 * 1024 * 1024,
  });
}
