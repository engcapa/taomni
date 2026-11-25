import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const catalog = "modules.json";
const signature = "modules.json.minisig";
const releaseTag = /^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.]+)*$/;
const runGh = (args) => execFileSync("gh", args, { encoding: "utf8" });

const releaseQuery = `query($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    latestRelease { ...assets }
    releases(first: 30, after: $cursor, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { ...assets }
      pageInfo { hasNextPage endCursor }
    }
  }
}
fragment assets on Release {
  tagName isDraft isPrerelease
  updater: releaseAssets(name: "latest.json", first: 1) { totalCount }
  catalog: releaseAssets(name: "modules.json", first: 1) { totalCount }
  signature: releaseAssets(name: "modules.json.minisig", first: 1) { totalCount }
}`;

function* coreReleases(gh) {
  let cursor;
  do {
    const args = ["api", "graphql", "-F", "owner={owner}", "-F", "repo={repo}", "-f", `query=${releaseQuery}`];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    const { latestRelease, releases } = JSON.parse(gh(args)).data.repository;
    if (!cursor && latestRelease) yield latestRelease;
    // A newly published core tag can still be waiting for its bundle assets.
    // Only a previous core release with an updater can supply its catalog.
    for (const release of releases.nodes) {
      if (release.tagName !== latestRelease?.tagName && !release.isDraft && !release.isPrerelease && release.updater.totalCount) {
        yield release;
      }
    }
    cursor = releases.pageInfo.hasNextPage ? releases.pageInfo.endCursor : null;
  } while (cursor);
}

export function publishedModuleCatalogTag(gh = runGh) {
  for (const release of coreReleases(gh)) {
    const { tagName } = release;
    if (!release.catalog.totalCount && !release.signature.totalCount) continue;
    if (release.catalog.totalCount !== 1 || release.signature.totalCount !== 1) {
      throw new Error(`Release ${tagName} has an incomplete signed module catalog`);
    }
    if (!release.updater.totalCount) continue;
    if (!releaseTag.test(tagName)) throw new Error("The public core release has an invalid tag");
    return tagName;
  }
}

/** Stage the signed index for a core-only release after modules have shipped. */
export function stagePublishedModuleCatalog(output, gh = runGh, { allowMissing = false } = {}) {
  const tagName = publishedModuleCatalogTag(gh);
  if (!tagName) {
    if (allowMissing) return undefined;
    throw new Error("The first modular release needs a complete signed module catalog");
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, option, ...extra] = process.argv.slice(2);
  if (!directory || extra.length || (option && option !== "--allow-missing")) {
    throw new Error("Usage: node scripts/stage-published-module-catalog.mjs DIRECTORY [--allow-missing]");
  }
  const source = stagePublishedModuleCatalog(directory, runGh, { allowMissing: option === "--allow-missing" });
  if (source) console.log(`source_tag=${source}`);
}
