import { cpSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const outDir = fileURLToPath(new URL("./dist/frontend", import.meta.url));

export default defineConfig({
  publicDir: false,
  plugins: [{
    name: "taoffice-media-license",
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
