import docWorker from "./legacy-doc.worker.js?worker&url";
import officeWorker from "./legacy-office.worker.js?worker&url";
import { MAX_DOCX_BYTES } from "./docxPackage.js";

const DOC_CONVERTER = new URL(/* @vite-ignore */ "./doc-converter_bg.wasm", import.meta.url);
const TIMEOUT_MS = 25_000;

export function isLegacyWordFormat(format) {
  return format === "doc" || format === "odt" || format === "rtf";
}

async function getAsset(url, signal) {
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error("Unavailable Word converter asset.");
    return await response.arrayBuffer();
  } catch (error) {
    signal.throwIfAborted();
    throw new Error("engine", { cause: error });
  }
}

function convertInWorker(script, input, wasm, format, signal) {
  const url = URL.createObjectURL(new Blob([script], { type: "text/javascript" }));
  let worker;
  let cancel;
  return new Promise((resolve, reject) => {
    try {
      worker = new Worker(url, { type: "module", name: `TaOffice ${format.toUpperCase()}` });
    } catch (error) {
      throw new Error("engine", { cause: error });
    }
    cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    worker.onmessage = ({ data }) => {
      if (data?.error) {
        reject(new Error(data.error));
        return;
      }
      const output = data?.output;
      if (!(output instanceof ArrayBuffer) || !output.byteLength || output.byteLength > MAX_DOCX_BYTES) {
        reject(new Error("limits"));
        return;
      }
      resolve(new Uint8Array(output));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      reject(new Error("engine"));
    };
    worker.onmessageerror = () => reject(new Error("engine"));
    worker.postMessage({ input, wasm, format, maxBytes: MAX_DOCX_BYTES }, wasm ? [input, wasm] : [input]);
  }).finally(() => {
    if (cancel) signal.removeEventListener("abort", cancel);
    worker?.terminate();
    URL.revokeObjectURL(url);
  });
}

export async function convertLegacyWord(bytes, format, signal) {
  signal.throwIfAborted();
  if (!bytes.byteLength) throw new Error("format");
  if (bytes.byteLength > MAX_DOCX_BYTES) throw new Error("limits");
  const task = new AbortController();
  const cancel = () => task.abort(signal.reason);
  const timer = setTimeout(() => task.abort(new Error("limits")), TIMEOUT_MS);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const [script, wasm] = await Promise.all([
      getAsset(format === "doc" ? docWorker : officeWorker, task.signal),
      format === "doc" ? getAsset(DOC_CONVERTER, task.signal) : undefined,
    ]);
    task.signal.throwIfAborted();
    return await convertInWorker(script, bytes.buffer, wasm, format, task.signal);
  } finally {
    task.abort();
    signal.removeEventListener("abort", cancel);
    clearTimeout(timer);
  }
}
