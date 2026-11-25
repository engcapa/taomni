import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CATALOG = "modules.json";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function publishedPackage(url) {
  const value = new URL(url);
  const name = decodeURIComponent(basename(value.pathname));
  if (value.origin !== "https://github.com" || value.username || value.password || value.search || value.hash
      || !/^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+$/.test(value.pathname)
      || !/^[a-zA-Z0-9._+-]+\.taomni-plugin$/.test(name)) {
    throw new Error(`Catalog package URL is invalid: ${url}`);
  }
  return name;
}

export async function fetchPublishedModuleAssets(catalogDirectory, outputDirectory, fetchImpl = fetch) {
  const catalog = readJson(join(catalogDirectory, CATALOG));
  if (!catalog || typeof catalog !== "object" || !catalog.plugins || typeof catalog.plugins !== "object") {
    throw new Error("Published module catalog has no plugins object");
  }
  mkdirSync(outputDirectory, { recursive: true });
  const entries = [];
  const repository = process.env.GITHUB_REPOSITORY || process.env.GH_REPO;
  for (const plugin of Object.values(catalog.plugins)) {
    for (const [platform, asset] of Object.entries(plugin.platforms ?? {})) {
      if (!asset || typeof asset.url !== "string" || typeof asset.signature !== "string") {
        throw new Error(`Catalog asset is incomplete for ${plugin.id}/${platform}`);
      }
      const name = publishedPackage(asset.url);
      const headers = { accept: "application/octet-stream" };
      if (process.env.GH_TOKEN && repository && new URL(asset.url).pathname.startsWith(`/${repository}/`)) {
        headers.authorization = `Bearer ${process.env.GH_TOKEN}`;
      }
      const options = { headers, redirect: "follow" };
      const signatureResponse = await fetchImpl(`${asset.url}.minisig`, options);
      if (!signatureResponse.ok) throw new Error(`Unable to download ${name}.minisig: HTTP ${signatureResponse.status}`);
      const signature = await signatureResponse.text();
      if (!signature.trim() || signature.trim() !== asset.signature.trim()) {
        throw new Error(`Published signature differs from the signed catalog for ${name}`);
      }
      const response = await fetchImpl(asset.url, options);
      if (!response.ok) throw new Error(`Unable to download ${name} from catalog: HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (asset.sha256 && asset.sha256 !== createHash("sha256").update(bytes).digest("hex")) {
        throw new Error(`Published package checksum mismatch for ${name}`);
      }
      writeFileSync(join(outputDirectory, name), bytes);
      writeFileSync(join(outputDirectory, `${name}.minisig`), signature);
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
