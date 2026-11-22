import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stagePublishedModuleCatalog } from "./stage-published-module-catalog.mjs";

const signedAssets = {
  "modules.json": ' { "sequence": 22, "plugins": {} }\n',
  "modules.json.minisig": "existing detached signature\n",
};
const coreAssets = { ...signedAssets, "latest.json": "{}" };

function fixture(t, releases) {
  const root = mkdtempSync(join(tmpdir(), "taomni-carry-catalog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, "carried-module-catalog");
  const calls = [];
  const gh = ([resource, command, ...args]) => {
    calls.push([command, ...args]);
    if (resource === "api") {
      assert.equal(command, "graphql");
      const offset = Number(args.find((arg) => arg.startsWith("cursor="))?.slice(7) || 0);
      const summary = ({ tagName, isDraft, isPrerelease, assets }) => ({
        tagName, isDraft, isPrerelease,
        updater: { totalCount: Number("latest.json" in assets) },
        catalog: { totalCount: Number("modules.json" in assets) },
        signature: { totalCount: Number("modules.json.minisig" in assets) },
      });
      const latest = releases.find((release) => release.isLatest);
      const page = releases.slice(offset, offset + 2);
      return JSON.stringify({ data: { repository: {
        latestRelease: latest ? summary(latest) : null,
        releases: { nodes: page.map(summary), pageInfo: {
          hasNextPage: offset + page.length < releases.length, endCursor: String(offset + page.length),
        } },
      } } });
    }
    assert.equal(resource, "release");
    const release = releases.find(({ tagName }) => tagName === args[0]);
    assert(release, "The selected release must exist");
    assert.equal(command, "download");
    assert.deepEqual(args.slice(1), ["--dir", output, "--pattern", "modules.json", "--pattern", "modules.json.minisig"]);
    for (const name of Object.keys(signedAssets)) {
      writeFileSync(join(output, name), release.assets[name]);
    }
    return "";
  };
  return { output, calls, gh };
}

test("carries the exact catalog bytes when the latest core release already has them", (t) => {
  const f = fixture(t, [
    { tagName: "v0.6.1-mail.2", assets: signedAssets },
    { tagName: "v0.6.1-mfa.1", assets: signedAssets },
    { tagName: "v0.6.1", isLatest: true, assets: coreAssets },
  ]);
  assert.equal(stagePublishedModuleCatalog(f.output, f.gh), "v0.6.1");
  for (const [name, value] of Object.entries(signedAssets)) {
    assert.equal(readFileSync(join(f.output, name), "utf8"), value);
  }
  assert.deepEqual(f.calls.slice(1).map(([command, tag]) => [command, tag]), [
    ["download", "v0.6.1"],
  ]);
});

test("a newly published core release can carry its predecessor's catalog", (t) => {
  const f = fixture(t, [
    { tagName: "v0.6.2", isLatest: true, assets: {} },
    { tagName: "v0.6.1-rdp.1", assets: signedAssets },
    { tagName: "v0.7.0", isDraft: true, assets: coreAssets },
    { tagName: "v0.7.0-beta.1", isPrerelease: true, assets: coreAssets },
    { tagName: "v0.6.1", assets: coreAssets },
  ]);
  assert.equal(stagePublishedModuleCatalog(f.output, f.gh), "v0.6.1");
  assert.equal(f.calls.filter(([command]) => command === "graphql").length, 3);
  assert.equal(readFileSync(join(f.output, "modules.json"), "utf8"), signedAssets["modules.json"]);
});

test("an incomplete or absent catalog fails before preparing an upload", (t) => {
  const incomplete = fixture(t, [
    { tagName: "v0.6.2", isLatest: true, assets: { "modules.json": signedAssets["modules.json"] } },
    { tagName: "v0.6.1", isLatest: false, assets: coreAssets },
  ]);
  assert.throws(() => stagePublishedModuleCatalog(incomplete.output, incomplete.gh), /incomplete signed module catalog/);
  assert(!existsSync(incomplete.output));
  const absent = fixture(t, [{ tagName: "v0.6.0", isLatest: true, assets: {} }]);
  assert.throws(() => stagePublishedModuleCatalog(absent.output, absent.gh), /needs a complete signed module catalog/);
  assert(!existsSync(absent.output));
});

test("allows an absent pre-modular catalog and still rejects a partial publication", (t) => {
  const absent = fixture(t, [{ tagName: "v0.5.10", isLatest: true, assets: {} }]);
  assert.equal(stagePublishedModuleCatalog(absent.output, absent.gh, { allowMissing: true }), undefined);
  assert(!existsSync(absent.output));
  const partial = fixture(t, [{
    tagName: "v0.6.0", isLatest: true, assets: { "modules.json.minisig": signedAssets["modules.json.minisig"] },
  }]);
  assert.throws(() => stagePublishedModuleCatalog(partial.output, partial.gh, { allowMissing: true }), /incomplete signed module catalog/);
  assert(!existsSync(partial.output));
});
