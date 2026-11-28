import { cpSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const require = createRequire(import.meta.url);
const officeParserDir = dirname(dirname(require.resolve("officeparser/slim")));
const outDir = fileURLToPath(new URL("./dist/frontend", import.meta.url));
const converter = fileURLToPath(new URL("./legacy-doc-wasm/target/frontend", import.meta.url));

export default defineConfig({
  base: "./",
  publicDir: false,
  plugins: [{
    name: "taoffice-word-host",
    enforce: "pre",
    resolveId(id) {
      if (id === "react/jsx-runtime" || id === "lucide-react") return `\0taoffice-word:${id}`;
    },
    load(id) {
      if (id === "\0taoffice-word:react/jsx-runtime") {
        return "export const { Fragment, jsx, jsxs } = globalThis.__taomniHost.jsxRuntime;";
      }
      if (id === "\0taoffice-word:lucide-react") {
        return "export const { Loader2 } = globalThis.__taomniHost.icons;";
      }
    },
    writeBundle() {
      for (const name of ["doc-converter_bg.wasm", "doc-converter-NOTICES.txt"]) {
        cpSync(join(converter, name), join(outDir, name));
      }
      cpSync(join(officeParserDir, "LICENSE"), join(outDir, "OfficeParser-LICENSE.txt"));
    },
  }],
  build: {
    outDir,
    emptyOutDir: true,
    target: ["chrome105", "safari16"],
    lib: {
      entry: fileURLToPath(new URL("./renderer/WordViewer.jsx", import.meta.url)),
      formats: ["es"],
      fileName: () => "index.js",
    },
  },
  worker: {
    format: "es",
    // The asset is fetched as bytes before creating a Blob Worker.
    // A static extension also keeps Vite's dev-server transforms out of those bytes.
    rolldownOptions: { output: { entryFileNames: "[name].txt", codeSplitting: false } },
  },
  oxc: {
    jsx: { runtime: "automatic" },
  },
});
