import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    outDir: fileURLToPath(new URL("./dist/frontend", import.meta.url)),
    emptyOutDir: true,
    target: ["chrome105", "safari16"],
    lib: {
      entry: fileURLToPath(new URL("./renderer/ProjectViewer.jsx", import.meta.url)),
      formats: ["es"],
      fileName: () => "index.js",
    },
  },
  oxc: {
    jsx: { runtime: "classic", pragma: "React.createElement", pragmaFrag: "React.Fragment" },
  },
});
