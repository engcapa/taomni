import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { composeUpdaterManifest } from "./compose-updater-manifest.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "taomni-updater-unit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifactsDir = join(root, "artifacts");
  const outputDir = join(root, "staged");
  mkdirSync(artifactsDir);
  const options = {
    artifactsDir, outputDir, tag: "v0.4.29", repository: "engcapa/taomni",
    notes: "Release notes", pubDate: "2026-10-02T00:00:00Z",
  };
  function add(artifact, name, bytes, signature = `${name}-signature`) {
    const path = join(artifactsDir, artifact, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    writeFileSync(`${path}.sig`, signature);
    return path;
  }
  add("taomni-0.4.29-macos-aarch64", "Taomni.app.tar.gz", "arm64 bytes", "arm64 signature\r\n");
  add("taomni-0.4.29-macos-x86_64", "Taomni.app.tar.gz", "intel bytes", "intel signature\n");
  add("taomni-0.4.29-ubuntu-22.04", "Taomni_0.4.29_amd64.AppImage", "appimage bytes");
  add("taomni-0.4.29-ubuntu-22.04", "Taomni_0.4.29_amd64.deb", "deb bytes");
  add("taomni-0.4.29-ubuntu-22.04", "Taomni-0.4.29-1.x86_64.rpm", "rpm bytes");
  add("taomni-0.4.29-windows-latest", "Taomni_0.4.29_x64_en-US.msi", "msi bytes");
  add("taomni-0.4.29-windows-latest", "Taomni_0.4.29_x64-setup.exe", "nsis bytes");
  return { root, artifactsDir, outputDir, options, add };
}

test("same-named macOS bundles keep distinct URLs, exact signed bytes and paired signatures", (t) => {
  const f = fixture(t);
  const result = composeUpdaterManifest(f.options);
  const arm = result.manifest.platforms["darwin-aarch64"];
  const intel = result.manifest.platforms["darwin-x86_64"];
  assert.match(arm.url, /Taomni_0\.4\.29_aarch64\.app\.tar\.gz$/);
  assert.match(intel.url, /Taomni_0\.4\.29_x86_64\.app\.tar\.gz$/);
  assert.notEqual(arm.url, intel.url);
  assert.equal(arm.signature, "arm64 signature");
  assert.equal(intel.signature, "intel signature");
  for (const [entry, bytes, signature] of [[arm, "arm64 bytes", "arm64 signature\r\n"], [intel, "intel bytes", "intel signature\n"]]) {
    const name = new URL(entry.url).pathname.split("/").at(-1);
    assert.equal(readFileSync(join(f.outputDir, name), "utf8"), bytes);
    assert.equal(readFileSync(join(f.outputDir, `${name}.sig`), "utf8"), signature);
  }
  assert.deepEqual(result.manifest.platforms["darwin-aarch64-app"], arm);
  assert.deepEqual(result.manifest.platforms["darwin-x86_64-app"], intel);
  assert.equal(result.manifest.version, "0.4.29");
  assert.equal(result.manifest.notes, "Release notes");
  assert.deepEqual(JSON.parse(readFileSync(join(f.outputDir, "latest.json"), "utf8")), result.manifest);
  assert(!readdirSync(f.outputDir).includes("Taomni.app.tar.gz"));
});

test("retains Linux installer targets and prefers NSIS over MSI regardless of file ordering", (t) => {
  const f = fixture(t);
  const { platforms } = composeUpdaterManifest(f.options).manifest;
  assert.match(platforms["windows-x86_64"].url, /-setup\.exe$/);
  assert.deepEqual(platforms["windows-x86_64"], platforms["windows-x86_64-nsis"]);
  assert.match(platforms["windows-x86_64-msi"].url, /\.msi$/);
  assert.match(platforms["linux-x86_64-deb"].url, /\.deb$/);
  assert.match(platforms["linux-x86_64-rpm"].url, /\.rpm$/);
  assert.deepEqual(platforms["linux-x86_64"], platforms["linux-x86_64-appimage"]);
});

test("uses MSI as Windows fallback when NSIS is absent", (t) => {
  const f = fixture(t);
  const exe = join(f.artifactsDir, "taomni-0.4.29-windows-latest", "Taomni_0.4.29_x64-setup.exe");
  rmSync(exe);
  rmSync(`${exe}.sig`);
  const { platforms } = composeUpdaterManifest(f.options).manifest;
  assert.deepEqual(platforms["windows-x86_64"], platforms["windows-x86_64-msi"]);
});

test("supports a selected macOS-only QA fixture without weakening the release default", (t) => {
  const f = fixture(t);
  rmSync(join(f.artifactsDir, "taomni-0.4.29-windows-latest"), { recursive: true });
  rmSync(join(f.artifactsDir, "taomni-0.4.29-ubuntu-22.04"), { recursive: true });
  assert.throws(() => composeUpdaterManifest(f.options), /missing required platform/);
  assert(!readdirSync(f.root).includes("staged"));
  const result = composeUpdaterManifest({ ...f.options, requiredPlatforms: ["darwin-aarch64", "darwin-x86_64"] });
  assert.equal(Object.keys(result.manifest.platforms).length, 4);
});

for (const failure of ["missing bundle", "empty signature", "missing signature", "duplicate target", "unknown artifact", "wrong version"]) {
  test(`rejects ${failure} before staging any assets`, (t) => {
    const f = fixture(t);
    const arm = join(f.artifactsDir, "taomni-0.4.29-macos-aarch64", "Taomni.app.tar.gz");
    if (failure === "missing bundle") rmSync(arm);
    if (failure === "empty signature") writeFileSync(`${arm}.sig`, " \r\n");
    if (failure === "missing signature") rmSync(`${arm}.sig`);
    if (failure === "duplicate target") f.add("taomni-0.4.29-macos-aarch64", "Duplicate.app.tar.gz", "different bytes");
    if (failure === "unknown artifact") f.add("unrecognized", "Other.app.tar.gz", "unknown bytes");
    if (failure === "wrong version") f.options.tag = "v0.4.30";
    assert.throws(() => composeUpdaterManifest(f.options));
    assert(!readdirSync(f.root).includes("staged"));
  });
}

test("refuses to overwrite nonempty staging directories", (t) => {
  const f = fixture(t);
  mkdirSync(f.outputDir);
  writeFileSync(join(f.outputDir, "keep.txt"), "preserve me");
  assert.throws(() => composeUpdaterManifest(f.options), /empty/);
  assert.equal(readFileSync(join(f.outputDir, "keep.txt"), "utf8"), "preserve me");
});

test("stages both macOS DMG installers alongside unchanged signed updater archives", (t) => {
  const f = fixture(t);
  for (const arch of ["aarch64", "x86_64"]) {
    writeFileSync(join(f.artifactsDir, `taomni-0.4.29-macos-${arch}`, `Taomni_0.4.29_${arch}.dmg`), `${arch} signed installer bytes`);
  }
  const result = composeUpdaterManifest({ ...f.options, requireMacosInstallers: true });
  assert.equal(result.installers.length, 2);
  for (const arch of ["aarch64", "x86_64"]) {
    assert.equal(readFileSync(join(f.outputDir, `Taomni_0.4.29_${arch}.dmg`), "utf8"), `${arch} signed installer bytes`);
  }
  assert(!Object.values(result.manifest.platforms).some((entry) => entry.url.endsWith(".dmg")));
});

test("requires both macOS installers for release staging without imposing installers on updater-only QA fixtures", (t) => {
  const f = fixture(t);
  assert.throws(() => composeUpdaterManifest({ ...f.options, requireMacosInstallers: true }), /Missing macOS release installer/);
  assert(!readdirSync(f.root).includes("staged"));
  assert.doesNotThrow(() => composeUpdaterManifest(f.options));
});

test("rejects same-named DMG installers before staging", (t) => {
  const f = fixture(t);
  for (const arch of ["aarch64", "x86_64"]) {
    writeFileSync(join(f.artifactsDir, `taomni-0.4.29-macos-${arch}`, "Taomni.dmg"), `${arch} installer`);
  }
  assert.throws(() => composeUpdaterManifest(f.options), /Conflicting release asset filename/);
  assert(!readdirSync(f.root).includes("staged"));
});
