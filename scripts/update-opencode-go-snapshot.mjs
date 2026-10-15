import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export function protocol(meta, provider) {
  const npm = meta.provider?.npm ?? provider.npm;
  if (npm === "@ai-sdk/openai") return meta.provider?.shape === "completions" ? "chat" : "responses";
  return { "@ai-sdk/openai-compatible": "chat", "@ai-sdk/anthropic": "messages", "@ai-sdk/google": "google" }[npm];
}
export function validate(provider, seed) {
  if (!provider?.models || !Object.keys(provider.models).length) throw new Error("Missing opencode-go models");
  const conflicts = Object.entries(seed.models).flatMap(([id, expected]) => {
    const meta = provider.models[id];
    const actual = meta && protocol(meta, provider);
    return actual && actual !== expected ? [`${id}: seed=${expected}, npm=${actual}`] : [];
  });
  if (conflicts.length) throw new Error(`Protocol conflict; manual review required:\n${conflicts.join("\n")}`);
}
async function main() {
  const seed = JSON.parse(await readFile(new URL("./opencode-go-protocol-seed.json", import.meta.url)));
  const path = new URL("../src-tauri/resources/opencode-go-catalog.snapshot.json", import.meta.url);
  if (process.argv.includes("--check")) {
    validate(JSON.parse(await readFile(path)), seed);
    console.log("Snapshot/seed valid (offline; no network)");
    return;
  }
  const response = await fetch("https://models.opencode.ai/api.json", {
    headers: { "User-Agent": "taomni/snapshot-updater" }, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
  const source = await response.text();
  const provider = JSON.parse(source)["opencode-go"];
  validate(provider, seed);
  await writeFile(path, JSON.stringify({
    ...provider, generated_at: new Date().toISOString(),
    source_digest: createHash("sha256").update(source).digest("hex"),
  }, null, 2) + "\n");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => {
  console.error(e.message); process.exitCode = 1;
});
