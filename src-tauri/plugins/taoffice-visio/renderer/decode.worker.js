globalThis.onmessage = async ({ data: { input, wasmBinary, icuData, stencils } }) => {
  try {
    const engine = await createVisioEngine({
      wasmBinary, locateFile: (filename) => filename, print: () => {}, printErr: () => {},
    });
    const icu = engine._malloc(icuData.byteLength);
    const payload = engine._malloc(input.byteLength);
    if (!icu || !payload) throw new Error("memory");
    engine.HEAPU8.set(new Uint8Array(icuData), icu);
    engine.HEAPU8.set(new Uint8Array(input), payload);
    if (engine._visio_init_icu(icu)) throw new Error("engine");

    const status = engine._visio_decode(payload, input.byteLength, stencils);
    if (status) {
      globalThis.postMessage({ error: status === 3 ? "limits" : "format" });
      return;
    }
    const pages = Array.from({ length: engine._visio_page_count() }, (_, index) => ({
      name: engine.UTF8ToString(engine._visio_page_name(index)),
      svg: engine.UTF8ToString(engine._visio_page_svg(index)),
    }));
    globalThis.postMessage({ pages });
  } catch (error) {
    globalThis.postMessage({ error: error.message === "memory" ? "limits" : "engine" });
  }
};
