import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const catalog = "modules.json";
const signature = "modules.json.minisig";
const releaseTag = /^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.]+)*$/;
const runGh = (args) => execFileSync("gh", args, { encoding: "utf8" });

/** Stage the signed index for a core-only release after modules have shipped. */
export function stagePublishedModuleCatalog(output, gh = runGh) {
  const releases = JSON.parse(gh([
    "release", "list", "--exclude-drafts", "--exclude-pre-releases", "--limit", "2", "--json", "tagName,isLatest",
  ])).sort((left, right) => Number(right.isLatest) - Number(left.isLatest));

  for (const { tagName } of releases) {
    if (!releaseTag.test(tagName)) throw new Error("The public core release has an invalid tag");
    const { assets } = JSON.parse(gh(["release", "view", tagName, "--json", "assets"]));
    const entries = assets.filter(({ name }) => name === catalog || name === signature);
    if (!entries.length) continue;
    if (entries.length !== 2 || new Set(entries.map(({ name }) => name)).size !== 2) {
      throw new Error(`Release ${tagName} has an incomplete signed module catalog`);
    }
    mkdirSync(output);
    try {
      gh(["release", "download", tagName, "--dir", output, "--pattern", catalog, "--pattern", signature]);
      for (const name of [catalog, signature]) {
        const path = join(output, name);
        if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`Missing release asset ${name}`);
      }
    } catch (error) {
      rmSync(output, { recursive: true, force: true });
      throw error;
    }
    return tagName;
  }
  throw new Error("The first modular release needs a complete signed module catalog");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory] = process.argv.slice(2);
  if (!directory) throw new Error("Usage: node scripts/stage-published-module-catalog.mjs DIRECTORY");
  const source = stagePublishedModuleCatalog(directory);
  console.log(`source_tag=${source}`);
}
