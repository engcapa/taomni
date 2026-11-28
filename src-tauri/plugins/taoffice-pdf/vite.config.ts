import { cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const require = createRequire(import.meta.url);
const pdfjs = dirname(require.resolve("pdfjs-dist/package.json"));
const outDir = fileURLToPath(new URL("./dist/frontend/", import.meta.url));

export default defineConfig({
  publicDir: false,
  plugins: [{
    name: "taoffice-pdf-assets",
    generateBundle(_options, output) {
      const entry = output["index.js"];
      if (!entry || entry.type !== "chunk" || entry.imports.length || Object.keys(output).length !== 1) {
        this.error("The PDF renderer must build as one standalone ESM entry.");
      }
      if (Object.keys(entry.modules).some((id) => id.replaceAll("\\", "/").includes("/node_modules/react/"))
        || /\bprocess\.env\b/.test(entry.code)) {
        this.error("The PDF renderer must use the host React runtime without Node globals.");
      }
    },
    writeBundle() {
      const destination = join(outDir, "pdfjs");
      mkdirSync(destination, { recursive: true });
      cpSync(join(dirname(require.resolve("@cantoo/pdf-lib")), "../LICENSE.md"), join(outDir, "pdf-lib-LICENSE.md"));
      cpSync(join(pdfjs, "LICENSE"), join(destination, "LICENSE"));
      cpSync(join(pdfjs, "legacy/build/pdf.worker.min.mjs"), join(destination, "pdf.worker.mjs"));
      for (const folder of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
        cpSync(join(pdfjs, folder), join(destination, folder), {
          recursive: true,
          filter: (source) => !/quickjs/i.test(source),
        });
      }
    },
  }],
  build: {
    outDir,
    emptyOutDir: true,
    target: ["chrome105", "safari16"],
    lib: {
      entry: fileURLToPath(new URL("renderer/PdfViewer.jsx", import.meta.url)),
      formats: ["es"],
      fileName: () => "index.js",
    },
    rolldownOptions: {
      platform: "browser",
      output: { codeSplitting: false },
    },
  },
  oxc: {
    jsx: { runtime: "classic", pragma: "React.createElement", pragmaFrag: "React.Fragment" },
  },
});
