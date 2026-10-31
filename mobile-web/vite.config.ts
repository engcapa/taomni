import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), {
    name: "mobile-offline-shell",
    closeBundle() {
      const output = fileURLToPath(new URL("../src-tauri/resources/mobile-web", import.meta.url));
      const files = ["index.html", "manifest.webmanifest", "icon.svg", ...readdirSync(join(output, "assets")).map(name => `assets/${name}`)];
      const revision = createHash("sha256");
      for (const name of files) revision.update(name).update(readFileSync(join(output, name)));
      const worker = readFileSync(join(output, "sw.js"), "utf8")
        .replace("__REVISION__", revision.digest("hex").slice(0, 16))
        .replace("__PRECACHE__", JSON.stringify(files.map(name => name === "index.html" ? "/" : `/${name}`)));
      writeFileSync(join(output, "sw.js"), worker);
    },
  }],
  server: { host: "127.0.0.1", port: 5001, strictPort: true },
  build: {
    outDir: "../src-tauri/resources/mobile-web", emptyOutDir: true,
    target: ["es2020", "safari16"],
  },
});
