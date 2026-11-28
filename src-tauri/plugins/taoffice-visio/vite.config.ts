import { appendFileSync, cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const outDir = fileURLToPath(new URL("./dist/frontend", import.meta.url));
const wasmBuild = fileURLToPath(new URL("./wasm/.build", import.meta.url));
const assets = ["visio.wasm", "visio-icu.dat", "visio-third-party-notices.txt"];
const notices = [
  ["fflate", "LICENSE"], ["@cantoo/pdf-lib", "LICENSE.md"], ["culori", "LICENSE"],
  ["html-entities", "LICENSE"], ["node-html-better-parser", "LICENSE"], ["tslib", "LICENSE.txt"],
];

export default defineConfig({
  publicDir: false,
  plugins: [{
    name: "taoffice-visio-host",
    enforce: "pre",
    resolveId(id) {
      if (id === "react" || id === "react/jsx-runtime" || id === "lucide-react") return `\0taoffice-visio:${id}`;
    },
    load(id) {
      if (id === "\0taoffice-visio:react") {
        return "const React = globalThis.__taomniHost.React; export default React; export const { useRef, useState } = React;";
      }
      if (id === "\0taoffice-visio:react/jsx-runtime") {
        return "export const { Fragment, jsx, jsxs } = globalThis.__taomniHost.jsxRuntime;";
      }
      if (id === "\0taoffice-visio:lucide-react") return "export const { Loader2 } = globalThis.__taomniHost.icons;";
    },
    writeBundle() {
      for (const asset of assets) cpSync(join(wasmBuild, asset), join(outDir, asset));
      for (const [name, file] of notices) {
        const license = new URL(`../../../node_modules/${name}/${file}`, import.meta.url);
        appendFileSync(join(outDir, "visio-third-party-notices.txt"), `\n${name}\n${readFileSync(license, "utf8")}`);
      }
    },
  }],
  build: {
    outDir,
    emptyOutDir: true,
    target: ["chrome105", "safari16"],
    lib: {
      entry: fileURLToPath(new URL("./renderer/VisioViewer.jsx", import.meta.url)),
      formats: ["es"],
      fileName: () => "index.js",
    },
    rolldownOptions: { platform: "browser", output: { codeSplitting: false } },
  },
  oxc: {
    jsx: { runtime: "automatic" },
  },
});
