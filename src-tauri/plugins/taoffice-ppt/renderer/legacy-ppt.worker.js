import { finalizeConvertedPresentation } from "./convertedPresentation.js";
import initialize, { convert_ppt } from "../legacy-ppt-wasm/target/frontend/ppt-converter.js";

globalThis.onmessage = async ({ data: { input, wasm } }) => {
  try {
    await initialize({ module_or_path: wasm });
  } catch {
    globalThis.postMessage({ error: "engine" });
    return;
  }

  try {
    const output = finalizeConvertedPresentation(convert_ppt(new Uint8Array(input)), "ppt").buffer;
    globalThis.postMessage({ output }, [output]);
  } catch (error) {
    globalThis.postMessage({ error: error.message === "limits" ? "limits" : "format" });
  }
};
