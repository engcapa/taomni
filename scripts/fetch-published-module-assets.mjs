import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CATALOG = "modules.json";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function packageName(url) {
  const value = new URL(url);
  const name = decodeURIComponent(basename(value.pathname));
  if (!name.endsWith(".taomni-plugin")) throw new Error(`Catalog package URL is invalid: ${url}`);
  return name;
}

export async function fetchPublishedModuleAssets(catalogDirectory, outputDirectory, fetchImpl = fetch) {
  const catalog = readJson(join(catalogDirectory, CATALOG));
  if (!catalog || typeof catalog !== "object" || !catalog.plugins || typeof catalog.plugins !== "object") {
    throw new Error("Published module catalog has no plugins object");
  }
  mkdirSync(outputDirectory, { recursive: true });
  const entries = [];
  for (const plugin of Object.values(catalog.plugins)) {
    for (const [platform, asset] of Object.entries(plugin.platforms ?? {})) {
      if (!asset || typeof asset.url !== "string" || typeof asset.signature !== "string") {
        throw new Error(`Catalog asset is incomplete for ${plugin.id}/${platform}`);
      }
      const name = packageName(asset.url);
      const response = await fetchImpl(asset.url, {
        headers: process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: "application/octet-stream" } : {},
        redirect: "follow",
      });
      if (!response.ok) throw new Error(`Unable to download ${name} from catalog: HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (asset.sha256 && asset.sha256 !== createHash("sha256").update(bytes).digest("hex")) {
        throw new Error(`Published package checksum mismatch for ${name}`);
      }
      writeFileSync(join(outputDirectory, name), bytes);
      writeFileSync(join(outputDirectory, `${name}.minisig`), asset.signature);
      entries.push({ id: plugin.id, platform, name });
    }
  }
  writeFileSync(join(outputDirectory, "asset-index.json"), `${JSON.stringify(entries, null, 2)}\n`);
  return entries;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [catalogDirectory, outputDirectory] = process.argv.slice(2);
  if (!catalogDirectory || !outputDirectory) throw new Error("Usage: node scripts/fetch-published-module-assets.mjs CATALOG_DIR OUTPUT_DIR");
  await fetchPublishedModuleAssets(catalogDirectory, outputDirectory);
  console.log(`Fetched published module assets into ${outputDirectory}`);
}
