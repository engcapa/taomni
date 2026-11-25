import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { compareSemver, verifyModuleCatalogDelta } from "./verify-module-catalog-delta.mjs";

const REPO = "engcapa/taomni";
const BASELINE_TAG = "v0.6.0";
const REHEARSAL_TAG = "v0.6.0-sockscap.0.1.13-rehearsal";
const SOURCE_SHA = "a".repeat(40);
const BASELINE_SHA = "b".repeat(40);
const PLATFORMS = ["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "windows-x86_64"];

function hex(char) {
  return char.repeat(64);
}

function makePlugin(slug, version, tag, digestChar) {
  const id = `taomni-plugin-${slug}`;
  const encodedTag = encodeURIComponent(tag);
  const platforms = {};
  for (const platform of PLATFORMS) {
    const filename = `${id}-${version}-${platform}.taomni-plugin`;
    platforms[platform] = {
      url: `https://github.com/${REPO}/releases/download/${encodedTag}/${encodeURIComponent(filename)}`,
      signature: `sig-${slug}-${version}-${platform}`,
      sha256: hex(digestChar),
      size: 1024 + platform.length,
    };
  }
  return {
    id,
    slug,
    name: slug,
    version,
    coreApiVersion: "1",
    platforms,
  };
}

function makeDeltaFixture() {
  const roster = JSON.parse(readFileSync(new URL("../src-tauri/plugins/legacy-upgrade.json", import.meta.url), "utf8"));
  const baselinePlugins = {};
  const nextPlugins = {};
  roster.forEach((id, idx) => {
    const slug = id.slice("taomni-plugin-".length);
    const version = slug === "sockscap" ? "0.1.12" : "0.1.0";
    const plugin = makePlugin(slug, version, BASELINE_TAG, String(idx));
    baselinePlugins[id] = plugin;
    nextPlugins[id] = slug === "sockscap"
      ? makePlugin("sockscap", "0.1.13", REHEARSAL_TAG, "f")
      : structuredClone(plugin);
  });
  const exception = {
    "taomni-plugin-mobile": { name: "Mobile", placement: "core", notes: "Mobile stays in core" },
  };
  const baselineCatalog = {
    coreApiVersion: "1",
    sequence: 1,
    updatedAt: "2026-11-23T00:00:00Z",
    legacyUpgrade: roster,
    releaseExceptions: exception,
    plugins: baselinePlugins,
  };
  const nextCatalog = {
    coreApiVersion: "1",
    sequence: 2,
    updatedAt: "2026-11-24T00:00:00Z",
    legacyUpgrade: [...roster],
    releaseExceptions: structuredClone(exception),
    plugins: nextPlugins,
  };
  const newAssets = [];
  const sumLines = [];
  for (const platform of PLATFORMS) {
    const filename = `taomni-plugin-sockscap-0.1.13-${platform}.taomni-plugin`;
    newAssets.push(filename, `${filename}.minisig`);
    sumLines.push(`${hex("f")}  ${filename}`);
  }
  return {
    baselineCatalog,
    nextCatalog,
    newAssets,
    sha256sumsText: `${sumLines.join("\n")}\n`,
    slug: "sockscap",
    tag: REHEARSAL_TAG,
    baselineTag: BASELINE_TAG,
    repository: REPO,
    sourceSha: SOURCE_SHA,
    baselineRunId: "45283305083",
    baselineSourceSha: BASELINE_SHA,
  };
}

test("compareSemver handles major/minor/patch and prerelease ordering", () => {
  assert.equal(compareSemver("0.1.13", "0.1.12"), 1);
  assert.equal(compareSemver("0.1.12", "0.1.12+meta"), 0);
  assert.equal(compareSemver("0.1.13", "0.1.13-rc.1"), 1);
  assert.equal(compareSemver("0.1.13-rc.2", "0.1.13-rc.10"), -1);
});

test("accepts a single-module delta preserving the 9 siblings and roster and writes CLI receipt", (t) => {
  const fixture = makeDeltaFixture();
  const receipt = verifyModuleCatalogDelta(fixture);
  assert.equal(receipt.schema, "taomni.module-catalog-delta.v1");
  assert.equal(receipt.module.previousVersion, "0.1.12");
  assert.equal(receipt.module.nextVersion, "0.1.13");
  assert.equal(receipt.unchangedModules.length, 9);
  assert.equal(receipt.updatedAssets.length, 8);
  assert.deepEqual(receipt.sequence, { previous: 1, next: 2 });

  const dir = mkdtempSync(join(tmpdir(), "taomni-delta-verify-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "base.json"), JSON.stringify(fixture.baselineCatalog));
  writeFileSync(join(dir, "next.json"), JSON.stringify(fixture.nextCatalog));
  writeFileSync(join(dir, "assets.json"), JSON.stringify(fixture.newAssets));
  writeFileSync(join(dir, "SHA256SUMS"), fixture.sha256sumsText);
  const out = join(dir, "out/receipt.json");
  const script = fileURLToPath(new URL("./verify-module-catalog-delta.mjs", import.meta.url));
  const res = spawnSync(process.execPath, [
    script,
    "--baseline", join(dir, "base.json"),
    "--next", join(dir, "next.json"),
    "--new-assets", join(dir, "assets.json"),
    "--sha256sums", join(dir, "SHA256SUMS"),
    "--module", "sockscap",
    "--tag", REHEARSAL_TAG,
    "--baseline-tag", BASELINE_TAG,
    "--repository", REPO,
    "--source-sha", SOURCE_SHA,
    "--baseline-run", "45283305083",
    "--baseline-sha", BASELINE_SHA,
    "--output", out,
  ], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), receipt);
});

test("rejects sequence regressions, version regressions, sibling drift, roster changes, and asset mismatches", () => {
  const cases = [
    ["same sequence", (f) => { f.nextCatalog.sequence = 1; }, /sequence must increase/],
    ["same target version", (f) => { f.nextCatalog.plugins["taomni-plugin-sockscap"].version = "0.1.12"; }, /did not increase/],
    ["modified sibling sha", (f) => { f.nextCatalog.plugins["taomni-plugin-mail"].platforms["linux-x86_64"].sha256 = hex("e"); }, /Sibling module modified/],
    ["modified sibling url", (f) => {
      const a = f.nextCatalog.plugins["taomni-plugin-mail"].platforms["linux-x86_64"];
      f.baselineCatalog.plugins["taomni-plugin-mail"].platforms["linux-x86_64"].url = a.url.replace(BASELINE_TAG, "v0.6.1");
      a.url = a.url.replace(BASELINE_TAG, "v0.6.1");
    }, /Sibling asset URL changed base tag/],
    ["changed legacyUpgrade", (f) => { f.nextCatalog.legacyUpgrade.pop(); }, /legacyUpgrade roster/],
    ["changed releaseExceptions", (f) => { delete f.nextCatalog.releaseExceptions; }, /releaseExceptions/],
    ["latest.json leaked into newAssets", (f) => { f.newAssets.push("latest.json"); }, /latest\.json/],
    ["missing signature in newAssets", (f) => { f.newAssets.pop(); }, /newAssets disagrees/],
    ["extra checksum entry", (f) => { f.sha256sumsText += `${hex("1")}  extra.taomni-plugin\n`; }, /SHA256SUMS inventory disagrees/],
    ["checksum digest mismatch", (f) => { f.sha256sumsText = f.sha256sumsText.replace(hex("f"), hex("0")); }, /SHA256SUMS digest mismatch/],
    ["rehearsal tag equals baseline tag", (f) => { f.tag = f.baselineTag; }, /Rehearsal tag must differ/],
  ];
  for (const [label, mutate, expected] of cases) {
    const f = makeDeltaFixture();
    mutate(f);
    assert.throws(() => verifyModuleCatalogDelta(f), expected, label);
  }
});
