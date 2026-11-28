globalThis.onmessage = async ({ data: { input, wasm } }) => {
  let engine;
  try {
    ({ instance: { exports: engine } } = await WebAssembly.instantiate(wasm, {}));
  } catch {
    globalThis.postMessage({ error: "engine" });
    return;
  }

  try {
    const pointer = engine.heif_input(input.byteLength);
    if (!pointer) {
      globalThis.postMessage({ error: "limits" });
      return;
    }
    new Uint8Array(engine.memory.buffer, pointer, input.byteLength).set(new Uint8Array(input));
    const status = engine.heif_decode();
    if (status) {
      globalThis.postMessage({ error: status === 1 ? "format" : status === 2 ? "limits" : "engine" });
      return;
    }
    const png = new Uint8Array(engine.memory.buffer, engine.heif_png(), engine.heif_png_length()).slice().buffer;
    globalThis.postMessage({ png, width: engine.heif_width(), height: engine.heif_height() }, [png]);
  } catch {
    // An allocation failure or trap is confined to this decoder instance.
    globalThis.postMessage({ error: "format" });
  }
};
