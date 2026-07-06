import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const artifactPaths = JSON.parse(process.env.TAURI_ACTION_ARTIFACT_PATHS || "[]");
const outDir = process.env.TAURI_ACTION_ARTIFACT_OUT_DIR;

if (!outDir) {
  throw new Error("TAURI_ACTION_ARTIFACT_OUT_DIR is required");
}
if (!Array.isArray(artifactPaths)) {
  throw new Error("TAURI_ACTION_ARTIFACT_PATHS must be a JSON array");
}

mkdirSync(outDir, { recursive: true });

let copied = 0;
for (const source of artifactPaths) {
  if (typeof source !== "string" || !source || !existsSync(source)) continue;
  if (statSync(source).isDirectory()) continue;
  copyFileSync(source, join(outDir, basename(source)));
  copied += 1;
}

if (copied === 0) {
  throw new Error("No Tauri action artifacts were copied");
}

console.log(`Copied ${copied} Tauri artifact(s) to ${outDir}`);
