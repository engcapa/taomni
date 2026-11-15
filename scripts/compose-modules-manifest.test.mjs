import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { composeModulesManifest } from "./compose-modules-manifest.mjs";

const moduleManifest = (overrides = {}) => ({
  id: "taomni-plugin-hello",
  slug: "hello",
  name: "Hello plugin",
  version: "1.2.3",
  coreApiVersion: "1",
  kind: "media",
  status: "stable",
  platforms: ["linux-x86_64", "windows-x86_64"],
  ...overrides,
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "taomni-modules-manifest-unit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifacts = join(root, "artifacts");
  const output = join(root, "output");
  const add = (platform, bytes = `${platform} bytes`, manifest = moduleManifest()) => {
    const directory = join(artifacts, `plugin-${manifest.slug}`, platform);
    mkdirSync(directory, { recursive: true });
    const packagePath = join(directory, `taomni-plugin-${manifest.slug}-${manifest.version}-${platform}.taomni-plugin`);
    writeFileSync(packagePath, bytes);
    writeFileSync(`${packagePath}.minisig`, `signature for ${platform}\n`);
    writeFileSync(join(directory, "module.json"), JSON.stringify(manifest));
    return packagePath;
  };
  return { root, artifacts, output, add };
}

test("composes platform entries with exact bytes, SHA-256 and detached signatures", (t) => {
  const f = fixture(t);
  f.add("linux-x86_64", "linux package");
  f.add("windows-x86_64", "windows package");
  const result = composeModulesManifest({
    artifactsDir: f.artifacts,
    outputDir: f.output,
    tag: "v0.6.0",
    repository: "engcapa/taomni",
    sequence: 42,
    updatedAt: "2026-11-15T00:00:00Z",
  });
  const plugin = result.manifest.plugins["taomni-plugin-hello"];
  assert.equal(result.manifest.coreApiVersion, "1");
  assert.equal(result.manifest.sequence, 42);
  assert.equal(plugin.version, "1.2.3");
  for (const [platform, bytes] of [["linux-x86_64", "linux package"], ["windows-x86_64", "windows package"]]) {
    const entry = plugin.platforms[platform];
    assert.match(entry.url, new RegExp(`taomni-plugin-hello-1\\.2\\.3-${platform}\\.taomni-plugin$`));
    assert.equal(entry.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(entry.size, Buffer.byteLength(bytes));
    assert.equal(readFileSync(join(f.output, `taomni-plugin-hello-1.2.3-${platform}.taomni-plugin`), "utf8"), bytes);
    assert.equal(readFileSync(join(f.output, `taomni-plugin-hello-1.2.3-${platform}.taomni-plugin.minisig`), "utf8"), `signature for ${platform}\n`);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(f.output, "modules.json"), "utf8")), result.manifest);
});

test("copies and reports the detached modules.json signature", (t) => {
  const f = fixture(t);
  f.add("linux-x86_64");
  writeFileSync(join(f.artifacts, "modules.json.minisig"), "manifest signature\n");
  const result = composeModulesManifest({ artifactsDir: f.artifacts, outputDir: f.output, tag: "v0.6.0", repository: "engcapa/taomni", requireManifestSignature: true });
  assert.equal(result.signedManifest, true);
  assert.equal(readFileSync(join(f.output, "modules.json.minisig"), "utf8"), "manifest signature\n");
});

for (const [name, mutate, expected] of [
  ["rejects a core API mismatch", (manifest) => ({ ...manifest, coreApiVersion: "2" }), /coreApiVersion/],
  ["rejects a missing manifest signature when required", (manifest) => manifest, /Missing detached modules/],
]) {
  test(name, (t) => {
    const f = fixture(t);
    const manifest = mutate(moduleManifest(), f);
    if (name.includes("missing manifest")) {
      f.add("linux-x86_64", "bytes", manifest);
      assert.throws(() => composeModulesManifest({ artifactsDir: f.artifacts, outputDir: f.output, tag: "v0.6.0", repository: "engcapa/taomni", requireManifestSignature: true }), expected);
    } else {
      f.add("linux-x86_64", "bytes", manifest);
      assert.throws(() => composeModulesManifest({ artifactsDir: f.artifacts, outputDir: f.output, tag: "v0.6.0", repository: "engcapa/taomni" }), expected);
    }
  });
}

test("rejects duplicate plugin platform entries", (t) => {
  const f = fixture(t);
  f.add("linux-x86_64", "first");
  const duplicateDir = join(f.artifacts, "duplicate");
  mkdirSync(duplicateDir, { recursive: true });
  const packagePath = join(duplicateDir, "hello-linux-x86_64.taomni-plugin");
  writeFileSync(packagePath, "second");
  writeFileSync(`${packagePath}.minisig`, "signature\n");
  writeFileSync(join(duplicateDir, "module.json"), JSON.stringify(moduleManifest()));
  assert.throws(() => composeModulesManifest({ artifactsDir: f.artifacts, outputDir: f.output, tag: "v0.6.0", repository: "engcapa/taomni" }), /Duplicate plugin target/);
});

test("rejects a missing package signature", (t) => {
  const f = fixture(t);
  const packagePath = f.add("linux-x86_64");
  rmSync(`${packagePath}.minisig`);
  assert.throws(() => composeModulesManifest({ artifactsDir: f.artifacts, outputDir: f.output, tag: "v0.6.0", repository: "engcapa/taomni" }), /Missing plugin signature/);
});

