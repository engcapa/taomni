import engine from "../wasm/.build/visio.mjs?raw";
import worker from "./decode.worker.js?raw";
import { editableVisio } from "./visioPackage.js";
import { preparePage } from "./visioSvg.js";

const MAX_INPUT = 32 * 1024 * 1024;
const TIMEOUT_MS = 25_000;
const stencils = new Set(["vss", "vst"]);
const assets = new URL(/* @vite-ignore */ "./", import.meta.url);

async function asset(name, signal) {
  const response = await fetch(new URL(name, assets), { signal });
  if (!response.ok) throw new Error("engine");
  return response.arrayBuffer();
}

export async function openVisio(source, signal) {
  const document = await source.read();
  if (!document.size) throw new Error("format");
  if (document.size > MAX_INPUT) throw new Error("limits");
  const input = await document.arrayBuffer();
  const editableInput = source.saveCopy && source.extension === "vsdx" ? new Uint8Array(input.slice(0)) : null;
  const pages = await decodeVisio(input, stencils.has(source.extension), signal);
  return { pages, diagram: editableInput && editableVisio(editableInput, pages) };
}

export async function decodeVisio(input, stencil, signal) {
  const [wasmBinary, icuData] = await Promise.all([asset("visio.wasm", signal), asset("visio-icu.dat", signal)]);
  if (signal.aborted) throw signal.reason;
  const script = URL.createObjectURL(new Blob([engine, "\n", worker], { type: "text/javascript" }));
  let decoder;
  try {
    decoder = new Worker(script, { type: "module", name: "TaOffice Visio" });
    const pages = await new Promise((resolve, reject) => {
      const finish = (callback, value) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        callback(value);
      };
      const abort = () => finish(reject, signal.reason);
      const timer = setTimeout(() => finish(reject, new Error("limits")), TIMEOUT_MS);
      signal.addEventListener("abort", abort, { once: true });
      decoder.onmessage = ({ data }) => {
        if (data.error) finish(reject, new Error(data.error));
        else finish(resolve, data.pages);
      };
      decoder.onerror = (event) => {
        event.preventDefault();
        finish(reject, new Error("engine"));
      };
      try {
        decoder.postMessage({ input, wasmBinary, icuData, stencils: stencil },
          [input, wasmBinary, icuData]);
      } catch (error) {
        finish(reject, error);
      }
    });
    if (signal.aborted) throw signal.reason;
    return pages.map(preparePage);
  } finally {
    decoder?.terminate();
    URL.revokeObjectURL(script);
  }
}
