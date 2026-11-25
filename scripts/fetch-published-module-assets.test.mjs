import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fetchPublishedModuleAssets } from "./fetch-published-module-assets.mjs";

const name = "taomni-plugin-mfa-0.1.0-linux-x86_64.taomni-plugin";
const url = `https://github.com/engcapa/taomni/releases/download/v0.6.0/${name}`;
const bytes = Buffer.from("published package");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const signature = "signed package";

function fixture(t, asset = {}) {
  const root = mkdtempSync(join(tmpdir(), "taomni-module-assets-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const catalogDir = join(root, "catalog");
  const output = join(root, "assets");
  const entry = { url, sha256, signature, ...asset };
  const plugin = { id: "taomni-plugin-mfa", platforms: { "linux-x86_64": entry } };
  mkdirSync(catalogDir);
  writeFileSync(join(catalogDir, "modules.json"), JSON.stringify({ plugins: { [plugin.id]: plugin } }));
  return { output, fetch: (fetchImpl) => fetchPublishedModuleAssets(catalogDir, output, fetchImpl) };
}

test("fetches the original published package and detached signature", async (t) => {
  const f = fixture(t);
  const calls = [];
  const entries = await f.fetch(async (location) => {
    calls.push(location);
    return new Response(location === url ? bytes : signature + "\n");
  });
  assert.deepEqual(calls, [url + ".minisig", url]);
  assert.deepEqual(entries, [{ id: "taomni-plugin-mfa", platform: "linux-x86_64", name }]);
  assert.deepEqual(readFileSync(join(f.output, name)), bytes);
  assert.equal(readFileSync(join(f.output, name + ".minisig"), "utf8"), signature + "\n");
});

for (const [error, sidecar] of [
  [/HTTP 404/, () => new Response(null, { status: 404 })],
  [/signature differs/, () => new Response("another signature")],
]) {
  test(`rejects an invalid public sidecar (${error.source}) before accepting a package`, async (t) => {
    const f = fixture(t);
    await assert.rejects(f.fetch(async (location) => {
      assert.equal(location, url + ".minisig");
      return sidecar();
    }), error);
    assert(!existsSync(join(f.output, name)));
    assert(!existsSync(join(f.output, "asset-index.json")));
  });
}

test("a substituted package fails even with a matching public signature", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.fetch(async (location) => new Response(location === url ? "changed bytes" : signature)), /checksum mismatch/);
  assert(!existsSync(join(f.output, name)));
});

test("invalid release asset paths are rejected before the request", async (t) => {
  for (const location of [url.replace("github.com", "example.org"), url.replace(name, "%2felsewhere.taomni-plugin")]) {
    const f = fixture(t, { url: location });
    await assert.rejects(f.fetch(() => assert.fail("unexpected download")), /URL is invalid/);
  }
});
