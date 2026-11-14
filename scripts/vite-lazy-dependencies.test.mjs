import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const viteSource = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");

test("explicit Vite dependency discovery includes Mermaid's CommonJS graph", () => {
  const optimize = viteSource.slice(viteSource.indexOf("optimizeDeps:"), viteSource.indexOf("// Tauri ships"));
  assert.match(optimize, /noDiscovery:\s*true/);
  const includes = /include:\s*\[([\s\S]*?)\]/.exec(optimize)?.[1] ?? "";
  assert.match(includes, /"mermaid"/,
    "Cold browser Mermaid imports must prebundle dayjs/CommonJS plugins when dependency discovery is off");
});
