import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { screenshotOcrPlugin } from "../../../vite-plugins/screenshotOcr.ts";

export default defineConfig({
  plugins: [screenshotOcrPlugin()],
  build: {
    target: ["es2020", "safari16"],
    outDir: fileURLToPath(new URL("./dist/frontend", import.meta.url)),
    emptyOutDir: true,
    lib: {
      entry: fileURLToPath(new URL("./renderer/index.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "index.js",
    },
  },
});
