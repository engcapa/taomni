import { cpSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const outDir = fileURLToPath(new URL("./dist/frontend", import.meta.url));

export default defineConfig({
  publicDir: false,
  plugins: [{
    name: "taoffice-media-host",
    enforce: "pre",
    resolveId(id) {
      if (id === "react" || id === "react/jsx-runtime" || id === "lucide-react") return "\0taoffice-media:" + id;
    },
    load(id) {
      if (id === "\0taoffice-media:react") return "export default globalThis.__taomniHost.React;";
      if (id === "\0taoffice-media:react/jsx-runtime") {
        return "export const { Fragment, jsx, jsxs } = globalThis.__taomniHost.jsxRuntime;";
      }
      if (id === "\0taoffice-media:lucide-react") return "export const { Loader2 } = globalThis.__taomniHost.icons;";
    },
    writeBundle() {
      cpSync(fileURLToPath(new URL("../../../node_modules/mediabunny/LICENSE", import.meta.url)),
        join(outDir, "mediabunny-LICENSE.txt"));
    },
  }],
  build: {
    outDir,
    emptyOutDir: true,
    target: ["chrome105", "safari16"],
    lib: {
      entry: fileURLToPath(new URL("./frontend/index.js", import.meta.url)),
      formats: ["es"],
      fileName: () => "index.js",
    },
    rolldownOptions: { platform: "browser", output: { codeSplitting: false } },
  },
});
