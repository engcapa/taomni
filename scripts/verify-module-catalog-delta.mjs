import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const TAG_RE = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseSemver(version) {
  const match = SEMVER_RE.exec(String(version ?? ""));
  if (!match) throw new Error(`Invalid semantic version: ${version}`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  };
}

export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1;
  }
  if (!left.pre.length && !right.pre.length) return 0;
  if (!left.pre.length) return 1;
  if (!right.pre.length) return -1;
  const len = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < len; i += 1) {
    const l = left.pre[i];
    const r = right.pre[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const lNum = /^\d+$/.test(l);
    const rNum = /^\d+$/.test(r);
    if (lNum && rNum) {
      const diff = Number(l) - Number(r);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    } else if (lNum !== rNum) {
      return lNum ? -1 : 1;
    } else if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

function parseSha256Sums(text) {
  const sums = new Map();
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    assert(match, `Invalid SHA256SUMS line: ${line}`);
    const [, digest, filename] = match;
    assert(!sums.has(filename), `Duplicate SHA256SUMS entry: ${filename}`);
    sums.set(filename, digest);
  }
  return sums;
}

function validatePlatformAsset(asset, label) {
  assert(isPlainObject(asset), `${label} must be an object`);
  assert(typeof asset.url === "string" && asset.url.length > 0, `${label} is missing url`);
  assert(SHA256_RE.test(asset.sha256 ?? ""), `${label} has invalid sha256`);
  assert(Number.isSafeInteger(asset.size) && asset.size > 0, `${label} has invalid size`);
  assert(typeof asset.signature === "string" && asset.signature.trim().length > 0, `${label} is missing signature`);
}

export function verifyModuleCatalogDelta({
  baselineCatalog,
  nextCatalog,
  newAssets,
  sha256sumsText,
  slug,
  tag,
  baselineTag,
  repository,
  sourceSha,
  baselineRunId,
  baselineSourceSha,
}) {
  assert(SLUG_RE.test(slug ?? ""), `Invalid module slug: ${slug}`);
  assert(TAG_RE.test(tag ?? ""), `Invalid release tag: ${tag}`);
  assert(TAG_RE.test(baselineTag ?? ""), `Invalid baseline release tag: ${baselineTag}`);
  assert(tag !== baselineTag, "Rehearsal tag must differ from baselineTag");
  assert(REPO_RE.test(repository ?? ""), `Invalid repository: ${repository}`);
  assert(SHA_RE.test(sourceSha ?? ""), `Invalid sourceSha: ${sourceSha}`);
  if (baselineRunId !== undefined && baselineRunId !== null && baselineRunId !== "") {
    assert(/^[1-9]\d*$/.test(String(baselineRunId)), `Invalid baselineRunId: ${baselineRunId}`);
  }
  if (baselineSourceSha !== undefined && baselineSourceSha !== null && baselineSourceSha !== "") {
    assert(SHA_RE.test(baselineSourceSha), `Invalid baselineSourceSha: ${baselineSourceSha}`);
  }
  assert(isPlainObject(baselineCatalog), "baselineCatalog must be an object");
  assert(isPlainObject(nextCatalog), "nextCatalog must be an object");
  assert(
    /^\d+$/.test(String(nextCatalog.coreApiVersion ?? "")) &&
      nextCatalog.coreApiVersion === baselineCatalog.coreApiVersion,
    "coreApiVersion must remain unchanged",
  );
  assert(
    Number.isSafeInteger(baselineCatalog.sequence) && baselineCatalog.sequence >= 1 &&
      Number.isSafeInteger(nextCatalog.sequence) && nextCatalog.sequence > baselineCatalog.sequence,
    "sequence must increase above the baseline catalog",
  );
  assert(
    Array.isArray(baselineCatalog.legacyUpgrade) && baselineCatalog.legacyUpgrade.length > 0 &&
      isDeepStrictEqual(nextCatalog.legacyUpgrade, baselineCatalog.legacyUpgrade),
    "legacyUpgrade roster must be preserved unchanged",
  );
  assert(
    isDeepStrictEqual(nextCatalog.releaseExceptions ?? null, baselineCatalog.releaseExceptions ?? null),
    "releaseExceptions must be preserved unchanged",
  );
  assert(
    isPlainObject(baselineCatalog.plugins) && Object.keys(baselineCatalog.plugins).length > 0,
    "baselineCatalog.plugins must be non-empty",
  );
  assert(
    isPlainObject(nextCatalog.plugins) && Object.keys(nextCatalog.plugins).length > 0,
    "nextCatalog.plugins must be non-empty",
  );

  const targetId = `taomni-plugin-${slug}`;
  const baselineIds = Object.keys(baselineCatalog.plugins);
  const nextIds = Object.keys(nextCatalog.plugins);
  for (const id of baselineIds) {
    assert(Object.hasOwn(nextCatalog.plugins, id), `Baseline module missing from next catalog: ${id}`);
  }
  for (const id of nextIds) {
    assert(Object.hasOwn(baselineCatalog.plugins, id) || id === targetId, `Unexpected new module in catalog: ${id}`);
  }

  const baselinePrefix = `https://github.com/${repository}/releases/download/${encodeURIComponent(baselineTag)}/`;
  for (const id of baselineIds) {
    if (id === targetId) continue;
    assert(isDeepStrictEqual(nextCatalog.plugins[id], baselineCatalog.plugins[id]), `Sibling module modified unexpectedly: ${id}`);
    const platforms = nextCatalog.plugins[id]?.platforms;
    assert(isPlainObject(platforms) && Object.keys(platforms).length > 0, `Sibling module ${id} has invalid platforms`);
    for (const [platform, asset] of Object.entries(platforms)) {
      validatePlatformAsset(asset, `${id}/${platform}`);
      assert(asset.url.startsWith(baselinePrefix), `Sibling asset URL changed base tag for ${id}/${platform}: ${asset.url}`);
    }
  }

  const baselinePlugin = baselineCatalog.plugins[targetId];
  const nextPlugin = nextCatalog.plugins[targetId];
  assert(isPlainObject(nextPlugin) && nextPlugin.id === targetId && nextPlugin.slug === slug, `Target module invalid in next catalog: ${targetId}`);
  if (baselinePlugin) {
    assert(compareSemver(nextPlugin.version, baselinePlugin.version) > 0, `${targetId} version ${nextPlugin.version} did not increase above ${baselinePlugin.version}`);
  } else {
    parseSemver(nextPlugin.version);
  }
  assert(isPlainObject(nextPlugin.platforms) && Object.keys(nextPlugin.platforms).length > 0, `Target module ${targetId} has no platforms`);

  const targetPrefix = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/`;
  const expectedNewAssets = [];
  const expectedArchives = new Map();
  for (const [platform, asset] of Object.entries(nextPlugin.platforms)) {
    validatePlatformAsset(asset, `${targetId}/${platform}`);
    const filename = `${targetId}-${nextPlugin.version}-${platform}.taomni-plugin`;
    const expectedUrl = `${targetPrefix}${encodeURIComponent(filename)}`;
    assert(asset.url === expectedUrl, `Target asset URL mismatch for ${targetId}/${platform}: ${asset.url}`);
    expectedNewAssets.push(filename, `${filename}.minisig`);
    expectedArchives.set(filename, asset.sha256);
  }
  expectedNewAssets.sort();

  assert(Array.isArray(newAssets), "newAssets must be an array");
  assert(!newAssets.includes("latest.json"), "Core updater manifest latest.json must not be produced");
  assert(isDeepStrictEqual([...newAssets].sort(), expectedNewAssets), "newAssets disagrees with target module platforms");

  const sums = parseSha256Sums(sha256sumsText);
  assert(isDeepStrictEqual([...sums.keys()].sort(), [...expectedArchives.keys()].sort()), "SHA256SUMS inventory disagrees with updated archives");
  for (const [filename, expectedDigest] of expectedArchives) {
    assert(sums.get(filename) === expectedDigest, `SHA256SUMS digest mismatch for ${filename}`);
  }

  return {
    schema: "taomni.module-catalog-delta.v1",
    repository,
    sourceSha,
    baselineRunId: baselineRunId ? String(baselineRunId) : null,
    baselineSourceSha: baselineSourceSha ?? null,
    baselineTag,
    tag,
    module: {
      id: targetId,
      slug,
      previousVersion: baselinePlugin?.version ?? null,
      nextVersion: nextPlugin.version,
      platforms: Object.keys(nextPlugin.platforms).sort(),
    },
    sequence: {
      previous: baselineCatalog.sequence,
      next: nextCatalog.sequence,
    },
    coreApiVersion: String(nextCatalog.coreApiVersion),
    preservedLegacyUpgrade: [...nextCatalog.legacyUpgrade],
    unchangedModules: baselineIds.filter((id) => id !== targetId).sort(),
    updatedAssets: expectedNewAssets,
  };
}

function parseCliArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    assert(flag?.startsWith("--") && value !== undefined, "Usage: verify-module-catalog-delta.mjs --baseline ... --next ... --new-assets ... --sha256sums ... --module ... --tag ... --baseline-tag ... --repository ... --source-sha ... [--baseline-run ...] [--baseline-sha ...] [--output ...]");
    args[flag.slice(2)] = value;
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseCliArgs(process.argv.slice(2));
  const receipt = verifyModuleCatalogDelta({
    baselineCatalog: JSON.parse(readFileSync(args.baseline, "utf8")),
    nextCatalog: JSON.parse(readFileSync(args.next, "utf8")),
    newAssets: JSON.parse(readFileSync(args["new-assets"], "utf8")),
    sha256sumsText: readFileSync(args.sha256sums, "utf8"),
    slug: args.module,
    tag: args.tag,
    baselineTag: args["baseline-tag"],
    repository: args.repository,
    sourceSha: args["source-sha"],
    baselineRunId: args["baseline-run"],
    baselineSourceSha: args["baseline-sha"],
  });
  const encoded = `${JSON.stringify(receipt, null, 2)}\n`;
  if (args.output) {
    mkdirSync(dirname(args.output), { recursive: true });
    writeFileSync(args.output, encoded);
  }
  process.stdout.write(encoded);
}
