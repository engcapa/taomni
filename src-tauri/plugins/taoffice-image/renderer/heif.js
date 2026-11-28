import workerSource from "./heif.worker.js?raw";

const WASM_URL = new URL(/* @vite-ignore */ "./heif.wasm", import.meta.url);
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_AXIS = 1600;
const MAX_PNG_BYTES = 12 * 1024 * 1024;
const DECODE_TIMEOUT_MS = 25_000;

async function decoderBytes(signal) {
  try {
    const response = await fetch(WASM_URL, { signal });
    if (!response.ok) throw new Error("engine");
    return await response.arrayBuffer();
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new Error("engine", { cause: error });
  }
}

async function workerDecode(input, wasm, signal) {
  let url;
  let decoder;
  let abort;
  try {
    url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
    decoder = new Worker(url, { name: "TaOffice HEIF" });
  } catch (error) {
    if (url) URL.revokeObjectURL(url);
    throw new Error("engine", { cause: error });
  }
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      decoder.onmessage = ({ data }) => {
        const { error, png, width, height } = data ?? {};
        if (error === "format" || error === "limits" || error === "engine") {
          reject(new Error(error));
          return;
        }
        if (!(png instanceof ArrayBuffer) || !png.byteLength || png.byteLength > MAX_PNG_BYTES
          || !Number.isInteger(width) || width < 1 || width > MAX_AXIS
          || !Number.isInteger(height) || height < 1 || height > MAX_AXIS) {
          reject(new Error("engine"));
          return;
        }
        resolve({ blob: new Blob([png], { type: "image/png" }), width, height });
      };
      decoder.onerror = (event) => {
        event.preventDefault();
        reject(new Error("engine"));
      };
      decoder.onmessageerror = () => reject(new Error("engine"));
      try {
        decoder.postMessage({ input, wasm }, [input, wasm]);
      } catch (error) {
        reject(new Error("engine", { cause: error }));
      }
    });
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    decoder.terminate();
    URL.revokeObjectURL(url);
  }
}

export async function decodeHeif(bytes, signal) {
  signal?.throwIfAborted();
  if (!bytes.byteLength) throw new Error("format");
  if (bytes.byteLength > MAX_BYTES) throw new Error("limits");
  const task = new AbortController();
  const abort = () => task.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => task.abort(new Error("limits")), DECODE_TIMEOUT_MS);
  try {
    const wasm = await decoderBytes(task.signal);
    task.signal.throwIfAborted();
    // Transfer a private copy so callers can still use the file's original bytes.
    return await workerDecode(bytes.slice().buffer, wasm, task.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
