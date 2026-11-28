import { convertDocumentInWorker } from "../../../crates/taomni-plugin-api/frontend/documentConversion.js";
import docWorker from "./legacy-doc.worker.js?worker&url";
import officeWorker from "./legacy-office.worker.js?worker&url";
import { MAX_DOCX_BYTES } from "./docxPackage.js";

const DOC_CONVERTER = new URL(/* @vite-ignore */ "./doc-converter_bg.wasm", import.meta.url);

export function isLegacyWordFormat(format) {
  return format === "doc" || format === "odt" || format === "rtf";
}

export function convertLegacyWord(bytes, format, signal) {
  return convertDocumentInWorker({
    bytes, format, signal, maxBytes: MAX_DOCX_BYTES,
    worker: format === "doc" ? docWorker : officeWorker,
    wasmUrl: format === "doc" ? DOC_CONVERTER : undefined,
  });
}
