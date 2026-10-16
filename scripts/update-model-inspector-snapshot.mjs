import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const domains = {
  deepseek: "api.deepseek.com", agnes: "apihub.agnes-ai.com",
  anthropic: "api.anthropic.com", groq: "api.groq.com",
  zhipuai: "open.bigmodel.cn", "siliconflow-cn": "api.siliconflow.cn",
  siliconflow: "api.siliconflow.com",
};
export function extract(source) {
  const providers = {};
  for (const [key, domain] of Object.entries(domains)) {
    const provider = source[key];
    if (!provider?.models || !Object.keys(provider.models).length) throw new Error(`Missing subtree: ${key}`);
    // Some SDK-native providers omit api; validate the official documentation domain instead.
    const actual = new URL(provider.api ?? provider.doc).hostname;
    if (actual !== domain && !(key === "anthropic" && actual.endsWith(".anthropic.com"))
      && !(key === "groq" && actual.endsWith(".groq.com"))) throw new Error(`Unexpected domain ${key}: ${actual}`);
    providers[key] = provider;
  }
  if (source["opencode-go"]) providers["opencode-go"] = source["opencode-go"];
  return providers;
}
async function main() {
  const path = new URL("../src-tauri/resources/model-catalog.snapshot.json", import.meta.url);
  if (process.argv.includes("--check")) {
    const snapshot = JSON.parse(await readFile(path));
    extract(snapshot.providers);
    for (const [provider, entries] of Object.entries(snapshot.aliases)) {
      for (const alias of Object.values(entries)) {
        if (!snapshot.providers[provider]?.models[alias.target_id] || !alias.checked_at)
          throw new Error("Invalid alias registry");
      }
    }
    console.log("Model inspector snapshot valid (offline)");
    return;
  }
  const response = await fetch("https://models.opencode.ai/api.json", {
    headers: { "User-Agent": "taomni/model-catalog-snapshot" }, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
  const raw = await response.text();
  // Do not infer deepseek-chat's target from a similar name. Register only with independent evidence.
  await writeFile(path, JSON.stringify({
    generated_at: new Date().toISOString(), source_digest: createHash("sha256").update(raw).digest("hex"),
    providers: extract(JSON.parse(raw)), aliases: {},
    alias_note: "deepseek-chat is absent; target unconfirmed, intentionally unregistered",
  }) + "\n");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => {
  console.error(e.message); process.exitCode = 1;
});
