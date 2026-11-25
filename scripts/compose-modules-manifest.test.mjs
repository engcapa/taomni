import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { appendModuleReleaseNotes, composeModulesManifest } from "./compose-modules-manifest.mjs";

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
  const checksums = [];
  for (const [platform, bytes] of [["linux-x86_64", "linux package"], ["windows-x86_64", "windows package"]]) {
    const entry = plugin.platforms[platform];
    assert.match(entry.url, new RegExp(`taomni-plugin-hello-1\\.2\\.3-${platform}\\.taomni-plugin$`));
    assert.equal(entry.sha256, createHash("sha256").update(bytes).digest("hex"));
    checksums.push(`${entry.sha256}  taomni-plugin-hello-1.2.3-${platform}.taomni-plugin\n`);
    assert.equal(entry.size, Buffer.byteLength(bytes));
    assert.equal(readFileSync(join(f.output, `taomni-plugin-hello-1.2.3-${platform}.taomni-plugin`), "utf8"), bytes);
    assert.equal(readFileSync(join(f.output, `taomni-plugin-hello-1.2.3-${platform}.taomni-plugin.minisig`), "utf8"), `signature for ${platform}\n`);
  }
  assert.equal(readFileSync(join(f.output, "SHA256SUMS"), "utf8"), checksums.join(""));
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

test("publishes reviewed category and sorted permissions consistently across platforms", (t) => {
  const f = fixture(t);
  f.add("linux-x86_64", "linux", moduleManifest({ permissions: ["window.open", "capture.screen"] }));
  f.add("windows-x86_64", "windows", moduleManifest({ permissions: ["capture.screen", "window.open"] }));
  const result = composeModulesManifest({ artifactsDir: f.artifacts, outputDir: f.output, tag: "v0.6.0", repository: "engcapa/taomni" });
  assert.equal(result.manifest.plugins["taomni-plugin-hello"].kind, "media");
  assert.deepEqual(result.manifest.plugins["taomni-plugin-hello"].permissions, ["capture.screen", "window.open"]);
  assert.deepEqual(JSON.parse(readFileSync(join(f.output, "modules.json"), "utf8")), result.manifest);
});

test("rejects platform payloads that disagree about the permissions shown before download", (t) => {
  const f = fixture(t);
  f.add("linux-x86_64", "linux", moduleManifest({ permissions: [] }));
  f.add("windows-x86_64", "windows", moduleManifest({ permissions: ["capture.screen"] }));
  assert.throws(() => composeModulesManifest({ artifactsDir: f.artifacts, outputDir: f.output, tag: "v0.6.0", repository: "engcapa/taomni" }), /inconsistent metadata/);
});

test("keeps a complete legacy roster and the description of a separately added stable module", (t) => {
  const f = fixture(t);
  const baseline = moduleManifest({ description: "Old feature description" });
  f.add("linux-x86_64", "linux", baseline);
  f.add("windows-x86_64", "windows", baseline);
  f.add("linux-x86_64", "new", moduleManifest({
    slug: "next", id: "taomni-plugin-next", description: "New feature description", platforms: ["linux-x86_64"],
  }));
  const result = composeModulesManifest({ artifactsDir: f.artifacts, outputDir: f.output,
    tag: "v0.6.0", repository: "engcapa/taomni", legacyUpgrade: [baseline.id] });
  assert.deepEqual(result.manifest.legacyUpgrade, [baseline.id]);
  assert.equal(result.manifest.plugins["taomni-plugin-next"].description, "New feature description");
});

test("cannot publish an incomplete first-upgrade module", (t) => {
  const f = fixture(t);
  const manifest = moduleManifest({ description: "Old feature description" });
  f.add("linux-x86_64", "linux", manifest);
  assert.throws(() => composeModulesManifest({ artifactsDir: f.artifacts, outputDir: f.output,
    tag: "v0.6.0", repository: "engcapa/taomni", legacyUpgrade: [manifest.id] }), /all declared platform assets/);
});

test("the initial catalog uses the checked-in business roster and requires every platform", (t) => {
  const f = fixture(t);
  const roster = JSON.parse(readFileSync(new URL("../src-tauri/plugins/legacy-upgrade.json", import.meta.url), "utf8"));
  const script = fileURLToPath(new URL("./compose-modules-manifest.mjs", import.meta.url));
  const run = () => spawnSync(process.execPath, [script, f.artifacts, f.output, "--first-release"], {
    // An old operator setting cannot silently narrow the actual first release.
    env: { TAG: "v0.6.0", GITHUB_REPOSITORY: "engcapa/taomni", MODULES_LEGACY_UPGRADE_IDS: roster[0] },
    encoding: "utf8",
  });
  for (const id of roster) {
    const slug = id.slice("taomni-plugin-".length);
    const manifest = JSON.parse(readFileSync(new URL(`../src-tauri/plugins/${slug}/module.json`, import.meta.url), "utf8"));
    for (const platform of manifest.platforms) {
      f.add(platform, `${slug} ${platform}`, { ...manifest, status: "stable" });
    }
  }
  const complete = run();
  assert.equal(complete.status, 0, complete.stderr);
  const catalog = JSON.parse(readFileSync(join(f.output, "modules.json"), "utf8"));
  assert.deepEqual(catalog.legacyUpgrade, roster);
  assert.deepEqual(Object.keys(catalog.plugins), roster);
  rmSync(f.output, { recursive: true });
  rmSync(join(f.artifacts, "plugin-mail", "darwin-aarch64"), { recursive: true });
  const partial = run();
  assert.notEqual(partial.status, 0);
  assert.match(partial.stderr, /all declared platform assets for taomni-plugin-mail/);
});

test("the first roster records Mobile as continuing in the core and adds the release note once", (t) => {
  const f = fixture(t);
  const module = moduleManifest({ platforms: ["linux-x86_64"], description: "First module" });
  f.add("linux-x86_64", "first", module);
  const config = { artifactsDir: f.artifacts, outputDir: f.output, tag: "v0.6.0", repository: "engcapa/taomni" };
  const { manifest } = composeModulesManifest({ ...config, legacyUpgrade: [module.id] });
  const mobile = manifest.releaseExceptions["taomni-plugin-mobile"];
  assert.equal(mobile.placement, "core");
  assert.deepEqual(manifest.legacyUpgrade, [module.id]);
  const notes = appendModuleReleaseNotes("Modules are now available.", manifest);
  assert.ok(notes.startsWith(`Modules are now available.\n\n${mobile.notes}\n\n`));
  assert.match(notes, /installs the original set of official modules automatically/);
  assert.match(notes, /original Vault password/);
  assert.match(notes, /main WebView with access to the same application commands/);
  assert.equal(appendModuleReleaseNotes(`Modules are now available.\n\n${mobile.notes}`, manifest), notes);
  assert.equal(appendModuleReleaseNotes(notes, manifest), notes);

  const delta = composeModulesManifest({ ...config, outputDir: join(f.root, "delta") }).manifest;
  assert.equal(delta.releaseExceptions, undefined);
});

test("a core release inherits the published roster and advances past a module-only sequence", (t) => {
  const f = fixture(t);
  const first = moduleManifest({ description: "First feature", platforms: ["linux-x86_64"] });
  f.add("linux-x86_64", "first", first);
  f.add("linux-x86_64", "next", moduleManifest({
    id: "taomni-plugin-next", slug: "next", description: "New feature", platforms: ["linux-x86_64"],
  }));
  const previous = join(f.root, "published.json");
  writeFileSync(previous, JSON.stringify({ sequence: 42, legacyUpgrade: [first.id] }));
  const script = fileURLToPath(new URL("./compose-modules-manifest.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, f.artifacts, f.output], {
    env: {
      TAG: "v0.6.0", GITHUB_REPOSITORY: "engcapa/taomni", GITHUB_RUN_NUMBER: "11",
      MODULES_LEGACY_UPGRADE_IDS: "", MODULES_PUBLISHED_CATALOG: previous,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const catalog = JSON.parse(readFileSync(join(f.output, "modules.json"), "utf8"));
  assert.equal(catalog.sequence, 43);
  assert.deepEqual(catalog.legacyUpgrade, [first.id]);
  assert.equal(catalog.plugins["taomni-plugin-next"].description, "New feature");
});

test("a changed module can be staged against a roster containing other modules", (t) => {
  const f = fixture(t);
  const next = moduleManifest({ description: "Updated feature", platforms: ["linux-x86_64"] });
  f.add("linux-x86_64", "next", next);
  const previous = join(f.root, "published.json");
  writeFileSync(previous, JSON.stringify({ sequence: 42, legacyUpgrade: [next.id, "taomni-plugin-mail"] }));
  const script = fileURLToPath(new URL("./compose-modules-manifest.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, f.artifacts, f.output, "--delta"], {
    env: {
      TAG: "v0.6.0-hello.2", GITHUB_REPOSITORY: "engcapa/taomni", MODULE_SEQUENCE: "11",
      MODULES_PUBLISHED_CATALOG: previous,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const catalog = JSON.parse(readFileSync(join(f.output, "modules.json"), "utf8"));
  assert.equal(catalog.sequence, 43);
  assert.equal(catalog.legacyUpgrade, undefined);
  assert.deepEqual(Object.keys(catalog.plugins), [next.id]);
});

test("rehearsal-first-release accepts provisional roster modules while strict first-release rejects them", (t) => {
  const f = fixture(t);
  const roster = JSON.parse(readFileSync(new URL("../src-tauri/plugins/legacy-upgrade.json", import.meta.url), "utf8"));
  const script = fileURLToPath(new URL("./compose-modules-manifest.mjs", import.meta.url));
  for (const id of roster) {
    const slug = id.slice("taomni-plugin-".length);
    const manifest = JSON.parse(readFileSync(new URL(`../src-tauri/plugins/${slug}/module.json`, import.meta.url), "utf8"));
    for (const platform of manifest.platforms) {
      f.add(platform, `${slug} ${platform}`, { ...manifest, status: "provisional" });
    }
  }
  const run = (mode, extraEnv = {}) => spawnSync(process.execPath, [script, f.artifacts, f.output, mode], {
    env: { TAG: "v0.6.0", GITHUB_REPOSITORY: "engcapa/taomni", ...extraEnv },
    encoding: "utf8",
  });

  const strict = run("--first-release");
  assert.notEqual(strict.status, 0);
  assert.match(strict.stderr, /legacyUpgrade requires a stable module/);
  rmSync(f.output, { recursive: true, force: true });

  const rehearsal = run("--rehearsal-first-release");
  assert.equal(rehearsal.status, 0, rehearsal.stderr);
  const catalog = JSON.parse(readFileSync(join(f.output, "modules.json"), "utf8"));
  assert.deepEqual(catalog.legacyUpgrade, roster);
  assert.equal(catalog.releaseExceptions["taomni-plugin-mobile"].placement, "core");

  const previous = join(f.root, "published.json");
  writeFileSync(previous, JSON.stringify({ sequence: 1, legacyUpgrade: roster }));
  rmSync(f.output, { recursive: true, force: true });
  const replacePublished = run("--rehearsal-first-release", { MODULES_PUBLISHED_CATALOG: previous });
  assert.notEqual(replacePublished.status, 0);
  assert.match(replacePublished.stderr, /initial roster cannot replace/);

  rmSync(f.output, { recursive: true, force: true });
  rmSync(join(f.artifacts, "plugin-sockscap", "linux-x86_64"), { recursive: true, force: true });
  const missingPlatform = run("--rehearsal-first-release");
  assert.notEqual(missingPlatform.status, 0);
  assert.match(missingPlatform.stderr, /all declared platform assets for taomni-plugin-sockscap/);
});

