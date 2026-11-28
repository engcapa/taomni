import { cpSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const outDir = fileURLToPath(new URL("./dist/frontend", import.meta.url));
const wasmBuild = fileURLToPath(new URL("./heif-wasm/target/frontend", import.meta.url));
const assets = ["heif.wasm", "heif-third-party-notices.txt"];

export default defineConfig({
  publicDir: false,
  plugins: [{
    name: "taoffice-image-host",
    enforce: "pre",
    resolveId(id) {
      if (id === "react" || id === "react/jsx-runtime" || id === "lucide-react") return `\0taoffice-image:${id}`;
    },
    load(id) {
      if (id === "\0taoffice-image:react") {
        return "const React = globalThis.__taomniHost.React; export default React; export const { useRef, useState } = React;";
      }
      if (id === "\0taoffice-image:react/jsx-runtime") {
        return "export const { Fragment, jsx, jsxs } = globalThis.__taomniHost.jsxRuntime;";
      }
      if (id === "\0taoffice-image:lucide-react") return "export const { Loader2 } = globalThis.__taomniHost.icons;";
    },
    writeBundle() {
      for (const asset of assets) cpSync(join(wasmBuild, asset), join(outDir, asset));
    },
  }],
  build: {
    outDir,
    emptyOutDir: true,
    target: ["chrome105", "safari16"],
    lib: {
      entry: fileURLToPath(new URL("./renderer/ImageViewer.jsx", import.meta.url)),
      formats: ["es"],
      fileName: () => "index.js",
    },
    rolldownOptions: { platform: "browser", output: { codeSplitting: false } },
  },
  oxc: {
    jsx: { runtime: "automatic" },
  },
});
