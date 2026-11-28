import initialize, { convert_doc } from "../legacy-doc-wasm/target/frontend/doc-converter.js";

globalThis.onmessage = async ({ data: { input, wasm } }) => {
  try {
    await initialize({ module_or_path: wasm });
  } catch {
    globalThis.postMessage({ error: "engine" });
    return;
  }

  try {
    const output = convert_doc(new Uint8Array(input)).buffer;
    globalThis.postMessage({ output }, [output]);
  } catch (error) {
    globalThis.postMessage({ error: error.message === "limits" ? "limits" : "format" });
  }
};
