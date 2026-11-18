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

function fixture(t, releases) {
  const root = mkdtempSync(join(tmpdir(), "taomni-carry-catalog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, "carried-module-catalog");
  const calls = [];
  const gh = ([resource, command, ...args]) => {
    assert.equal(resource, "release");
    calls.push([command, ...args]);
    if (command === "list") {
      return JSON.stringify(releases.map(({ tagName, isLatest }) => ({ tagName, isLatest })));
    }
    const release = releases.find(({ tagName }) => tagName === args[0]);
    assert(release, "The selected release must exist");
    if (command === "view") {
      return JSON.stringify({ assets: Object.keys(release.assets).map((name) => ({ name })) });
    }
    assert.equal(command, "download");
    assert.deepEqual(args.slice(1), ["--dir", output, "--pattern", "modules.json", "--pattern", "modules.json.minisig"]);
    for (const [name, value] of Object.entries(release.assets)) {
      writeFileSync(join(output, name), value);
    }
    return "";
  };
  return { output, calls, gh };
}

test("carries the exact catalog bytes when the latest core release already has them", (t) => {
  const f = fixture(t, [
    { tagName: "v0.6.0", isLatest: false, assets: {} },
    { tagName: "v0.6.1", isLatest: true, assets: signedAssets },
  ]);
  assert.equal(stagePublishedModuleCatalog(f.output, f.gh), "v0.6.1");
  for (const [name, value] of Object.entries(signedAssets)) {
    assert.equal(readFileSync(join(f.output, name), "utf8"), value);
  }
  assert.deepEqual(f.calls.slice(1).map(([command, tag]) => [command, tag]), [
    ["view", "v0.6.1"], ["download", "v0.6.1"],
  ]);
});

test("a newly published core release can carry its predecessor's catalog", (t) => {
  const f = fixture(t, [
    { tagName: "v0.6.2", isLatest: true, assets: {} },
    { tagName: "v0.6.1", isLatest: false, assets: signedAssets },
  ]);
  assert.equal(stagePublishedModuleCatalog(f.output, f.gh), "v0.6.1");
  assert.equal(readFileSync(join(f.output, "modules.json"), "utf8"), signedAssets["modules.json"]);
});

test("an incomplete or absent catalog fails before preparing an upload", (t) => {
  const incomplete = fixture(t, [
    { tagName: "v0.6.2", isLatest: true, assets: { "modules.json": signedAssets["modules.json"] } },
    { tagName: "v0.6.1", isLatest: false, assets: signedAssets },
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
