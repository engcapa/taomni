import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, defineConfig } from "vite";

const outDir = fileURLToPath(new URL("./dist/frontend/", import.meta.url));
const rendererEntry = fileURLToPath(new URL("./renderer/PresentationViewer.jsx", import.meta.url));
const canvasEntry = fileURLToPath(new URL("./renderer/slideEngine.js", import.meta.url));
const converter = fileURLToPath(new URL("./legacy-ppt-wasm/target/frontend/", import.meta.url));
const modules = new URL("../../../node_modules/", import.meta.url);
const licenses = [
  ["officeparser/LICENSE", "OfficeParser-LICENSE.txt"],
  ["pptxviewjs/LICENSE", "PPTXViewJS-LICENSE.txt"],
  ["chart.js/LICENSE.md", "Chart.js-LICENSE.txt"],
  ["jszip/LICENSE.markdown", "JSZip-LICENSE.txt"],
  ["pptxgenjs/LICENSE", "PptxGenJS-LICENSE.txt"],
];

export default defineConfig({
  base: "./",
  publicDir: false,
  plugins: [{
    name: "taoffice-ppt-preview-bundle",
    enforce: "pre",
    resolveId(id) {
      if (id === "react" || id === "react/jsx-runtime" || id === "lucide-react") return "\0taoffice-ppt:" + id;
    },
    load(id) {
      if (id === "\0taoffice-ppt:react") return "export default globalThis.__taomniHost.React;";
      if (id === "\0taoffice-ppt:react/jsx-runtime") {
        return "export const { Fragment, jsx, jsxs } = globalThis.__taomniHost.jsxRuntime;";
      }
      if (id === "\0taoffice-ppt:lucide-react") return "export const { Loader2 } = globalThis.__taomniHost.icons;";
    },
    async writeBundle() {
      await build({
        configFile: false,
        publicDir: false,
        build: {
          outDir,
          emptyOutDir: false,
          target: ["chrome105", "safari16"],
          lib: { entry: canvasEntry, name: "TaOfficeSlidePreview", formats: ["iife"], fileName: () => "slide-engine.js" },
          rolldownOptions: { platform: "browser", output: { codeSplitting: false } },
        },
      });
      mkdirSync(outDir, { recursive: true });
      for (const name of ["ppt-converter_bg.wasm", "ppt-converter-NOTICES.txt"]) {
        cpSync(join(converter, name), join(outDir, name));
      }
      for (const [upstream, destination] of licenses) {
        cpSync(fileURLToPath(new URL(upstream, modules)), join(outDir, destination));
      }
    },
  }],
  build: {
    outDir,
    emptyOutDir: true,
    target: ["chrome105", "safari16"],
    lib: { entry: rendererEntry, formats: ["es"], fileName: () => "index.js" },
    rolldownOptions: { platform: "browser", output: { codeSplitting: false } },
  },
  worker: {
    format: "es",
    rolldownOptions: { output: { entryFileNames: "[name].txt", codeSplitting: false } },
  },
  oxc: {
    jsx: { runtime: "automatic" },
  },
});
