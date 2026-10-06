import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

/** Bundle a closed, version-locked asset list: no runtime CDN or model download. */
export function screenshotOcrPlugin(): Plugin {
  const require = createRequire(import.meta.url);
  const root = (name: string) => dirname(require.resolve(`${name}/package.json`));
  const files = new Map<string, string>([
    ["worker.min.js", join(root("tesseract.js"), "dist/worker.min.js")],
    ["eng.traineddata.gz", join(root("@tesseract.js-data/eng"), "4.0.0_best_int/eng.traineddata.gz")],
    ["chi_sim.traineddata.gz", join(root("@tesseract.js-data/chi_sim"), "4.0.0_best_int/chi_sim.traineddata.gz")],
    ...["tesseract-core-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js"].map((file) =>
      [file, join(root("tesseract.js-core"), file)] as [string, string]),
    ["Tesseract-LICENSE.txt", join(root("tesseract.js"), "LICENSE.md")],
    ["Tesseract-core-LICENSE.txt", join(root("tesseract.js-core"), "LICENSE")],
  ]);
  return {
    name: "screenshot-offline-ocr",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        if (!url.startsWith("/screenshot-ocr/")) return next();
        const name = url.slice("/screenshot-ocr/".length);
        const file = files.get(name);
        if (!file) { res.statusCode = 404; res.end(); return; }
        res.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : "application/octet-stream");
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const [name, file] of files) {
        this.emitFile({ type: "asset", fileName: `screenshot-ocr/${name}`, source: readFileSync(file) });
      }
    },
  };
}
