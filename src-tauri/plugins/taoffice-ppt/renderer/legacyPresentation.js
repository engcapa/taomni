import { convertDocumentInWorker } from "../../../crates/taomni-plugin-api/frontend/documentConversion.js";
import pptWorker from "./legacy-ppt.worker.js?worker&url";
import odpWorker from "./legacy-odp.worker.js?worker&url";
import { MAX_PRESENTATION_BYTES } from "./presentationPackage.js";

const PPT_CONVERTER = new URL(/* @vite-ignore */ "./ppt-converter_bg.wasm", import.meta.url);

export function convertLegacyPresentation(bytes, format, signal) {
  return convertDocumentInWorker({
    bytes, format, signal, maxBytes: MAX_PRESENTATION_BYTES,
    worker: format === "ppt" ? pptWorker : odpWorker,
    wasmUrl: format === "ppt" ? PPT_CONVERTER : undefined,
  });
}
