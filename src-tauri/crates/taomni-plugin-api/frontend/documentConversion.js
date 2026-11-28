const TIMEOUT_MS = 25_000;

async function getAsset(url, signal) {
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error("Unavailable converter asset.");
    return await response.arrayBuffer();
  } catch (error) {
    signal.throwIfAborted();
    throw new Error("engine", { cause: error });
  }
}

function convertInWorker(script, input, wasm, format, maxBytes, signal) {
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
      if (!(output instanceof ArrayBuffer) || !output.byteLength || output.byteLength > maxBytes) {
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
    worker.postMessage({ input, wasm, format, maxBytes }, wasm ? [input, wasm] : [input]);
  }).finally(() => {
    if (cancel) signal.removeEventListener("abort", cancel);
    worker?.terminate();
    URL.revokeObjectURL(url);
  });
}

export async function convertDocumentInWorker({ bytes, format, worker, wasmUrl, maxBytes, signal }) {
  signal.throwIfAborted();
  if (!bytes.byteLength) throw new Error("format");
  if (bytes.byteLength > maxBytes) throw new Error("limits");
  const task = new AbortController();
  const cancel = () => task.abort(signal.reason);
  const timer = setTimeout(() => task.abort(new Error("limits")), TIMEOUT_MS);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const [script, wasm] = await Promise.all([
      getAsset(worker, task.signal),
      wasmUrl ? getAsset(wasmUrl, task.signal) : undefined,
    ]);
    task.signal.throwIfAborted();
    const input = bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
    return await convertInWorker(script, input, wasm, format, maxBytes, task.signal);
  } finally {
    task.abort();
    signal.removeEventListener("abort", cancel);
    clearTimeout(timer);
  }
}
