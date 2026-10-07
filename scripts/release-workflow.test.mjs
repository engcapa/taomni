import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const workflow = readFileSync(fileURLToPath(new URL("../.github/workflows/release.yml", import.meta.url)), "utf8").replaceAll("\r\n", "\n");
test("artifact-only selection controls builders and cannot enter the publishing job", () => {
  assert(workflow.includes("    if: needs.plan.outputs.build_desktop == 'true'"));
  const finalizer = workflow.split("  finalize-updater-manifest:\n")[1];
  assert(finalizer.includes("    needs: [plan, build, build-macos]"));
  assert(finalizer.includes("    if: needs.plan.outputs.tag != ''"));
  assert.equal((workflow.match(/RELEASE_TEST_VERSION: \$\{\{ needs.plan.outputs.test_version \}\}/g) ?? []).length, 2);
  for (const arch of ["aarch64", "x86_64"]) {
    for (const name of ["Stage and verify xray-core", "Build macOS bundle", "Verify fixed signature and updater app", "Collect workflow artifacts", "Upload workflow artifacts"]) {
      const step = workflow.split(`      - name: ${name} (${arch})\n`)[1]?.split("      - name:")[0];
      assert(step?.includes(`        if: needs.plan.outputs.macos_${arch} == 'true'`), `${name} (${arch}) must follow the validated build selection`);
    }
  }
});
const publishStep = workflow.split("      - name: Verify and publish release assets\n")[1];
assert(publishStep, "the tested publishing step must exist in release.yml");
const publishScript = publishStep.split("        run: |\n")[1].split("\n")
  .map((line) => line.startsWith("          ") ? line.slice(10) : line).join("\n");

function fixture(t, tag = "v0.4.30") {
  const root = mkdtempSync(join(tmpdir(), "taomni-release-workflow-unit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, bytes) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };
  for (const name of ["compose-updater-manifest.mjs", "verify-updater-signatures.mjs"]) {
    const destination = join(root, "scripts", name);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(fileURLToPath(new URL(name, import.meta.url)), destination);
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = Buffer.from("12345678");
  const pubkey = Buffer.from(`untrusted comment: test public key\n${Buffer.concat([Buffer.from("Ed"), keyId, publicKey.export({ format: "der", type: "spki" }).subarray(-32)]).toString("base64")}\n`).toString("base64");
  put(join(root, "src-tauri/tauri.conf.json"), JSON.stringify({ plugins: { updater: { pubkey } } }));
  const version = tag.slice(1);
  const signedPaths = [];
  const add = (platform, name) => {
    const path = join(root, "artifacts", `taomni-${version}-${platform}`, name);
    const bytes = Buffer.from(`${platform}: exact ${name} bytes`);
    put(path, bytes);
    const signature = sign(null, createHash("blake2b512").update(bytes).digest(), privateKey);
    const comment = "test trusted comment";
    const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
    put(`${path}.sig`, Buffer.from(`untrusted comment: test signature\n${Buffer.concat([Buffer.from("ED"), keyId, signature]).toString("base64")}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`).toString("base64"));
    signedPaths.push(path);
  };
  for (const arch of ["aarch64", "x86_64"]) {
    add(`macos-${arch}`, "Taomni.app.tar.gz");
    put(join(root, "artifacts", `taomni-${version}-macos-${arch}`, `Taomni_${version}_${arch}.dmg`), `${arch} installer bytes`);
  }
  add("ubuntu-22.04", `Taomni_${version}.AppImage`);
  add("ubuntu-22.04", `Taomni_${version}.deb`);
  add("ubuntu-22.04", `Taomni_${version}.rpm`);
  add("windows-latest", `Taomni_${version}-setup.exe`);
  add("windows-latest", `Taomni_${version}.msi`);
  const gh = join(root, "bin/gh");
  put(gh, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_GH_TRACE, JSON.stringify(args) + "\\n");
if (args[1] === "view") {
  if (args.includes("isDraft") && !process.env.TEST_GH_EXISTING_RELEASE && !process.env.TEST_GH_EXISTING_DRAFT) process.exit(1);
  if (args.includes("body") && process.env.TEST_GH_NOTES_FAIL) process.exit(1);
  console.log(args.includes("body") ? "Release notes with literal $(content)" : String(Boolean(process.env.TEST_GH_EXISTING_DRAFT)));
}
if (args[1] === "upload" && process.env.TEST_GH_UPLOAD_FAIL && !args[3].endsWith("latest.json")) process.exit(1);
`);
  chmodSync(gh, 0o755);
  const trace = join(root, "gh-trace");
  const env = {
    ...process.env, TEST_GH_MOCK: gh, TEST_NODE: process.execPath,
    TAG: tag, GH_REPO: "engcapa/taomni", GITHUB_REPOSITORY: "engcapa/taomni", GITHUB_SHA: "fixture-commit",
    TEST_GH_TRACE: trace, RELEASE_NOTES: "",
  };
  return {
    root, signedPaths,
    calls: () => existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse) : [],
    run: (overrides = {}) => spawnSync("bash", ["-c", 'gh() { "$TEST_NODE" "$TEST_GH_MOCK" "$@"; };\n' + publishScript], { cwd: root, env: { ...env, ...overrides }, encoding: "utf8", timeout: 60_000 }),
  };
}

test("builders only store workflow artifacts; finalizer uploads installers/updates before latest.json", (t) => {
  assert(!workflow.includes("tagName:"));
  assert(!workflow.includes("releaseId:"));
  const f = fixture(t);
  const result = f.run({ TEST_GH_EXISTING_RELEASE: "1" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const calls = f.calls();
  assert(!calls.some((args) => args[1] === "create"));
  const uploads = calls.filter((args) => args[1] === "upload");
  assert.equal(uploads.length, 17);
  assert.equal(uploads.at(-1)[3], "updater-assets/latest.json");
  assert.equal(uploads.filter((args) => args[3].endsWith(".dmg")).length, 2);
  assert.equal(uploads.filter((args) => args[3].endsWith(".app.tar.gz")).length, 2);
  const manifest = JSON.parse(readFileSync(join(f.root, "updater-assets/latest.json"), "utf8"));
  assert.equal(manifest.notes, "Release notes with literal $(content)");
  assert.notEqual(manifest.platforms["darwin-aarch64"].url, manifest.platforms["darwin-x86_64"].url);
});

for (const tag of ["v0.4.30", "v0.4.31-beta.1"]) {
  test(`creates a missing ${tag} release only after local gates and selects prerelease correctly`, (t) => {
    const f = fixture(t, tag);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const creates = f.calls().filter((args) => args[1] === "create");
    assert.equal(creates.length, 1);
    assert.equal(creates[0].includes("--prerelease"), tag.includes("-"));
    assert(creates[0].includes("--generate-notes"));
    assert(creates[0].includes("--draft"));
    assert.equal(creates[0][creates[0].indexOf("--target") + 1], "fixture-commit");
    const calls = f.calls();
    assert.deepEqual(calls.at(-1), ["release", "edit", tag, "--draft=false"]);
    assert.equal(calls.at(-2)[3], "updater-assets/latest.json");
  });
}

test("a rerun completes an existing draft after every asset and the manifest have been uploaded", (t) => {
  const f = fixture(t);
  const result = f.run({ TEST_GH_EXISTING_DRAFT: "1" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const calls = f.calls();
  assert(!calls.some((args) => args[1] === "create"));
  assert.equal(calls.at(-2)[3], "updater-assets/latest.json");
  assert.deepEqual(calls.at(-1), ["release", "edit", "v0.4.30", "--draft=false"]);
});

for (const failure of ["modified archive", "missing signature", "missing installer"]) {
  test(`makes no GitHub calls when staging/verification rejects a ${failure}`, (t) => {
    const f = fixture(t);
    if (failure === "modified archive") writeFileSync(f.signedPaths[0], "changed bytes");
    if (failure === "missing signature") rmSync(`${f.signedPaths[0]}.sig`);
    if (failure === "missing installer") rmSync(join(f.root, "artifacts/taomni-0.4.30-macos-aarch64/Taomni_0.4.30_aarch64.dmg"));
    assert.notEqual(f.run().status, 0);
    assert.deepEqual(f.calls(), []);
  });
}

test("failed uploads never publish latest.json and failed release-note reads stop publication", (t) => {
  const upload = fixture(t);
  assert.notEqual(upload.run({ TEST_GH_UPLOAD_FAIL: "1" }).status, 0);
  assert(!upload.calls().some((args) => args[1] === "upload" && args[3].endsWith("latest.json")));
  assert(!upload.calls().some((args) => args[1] === "edit"));
  const notes = fixture(t);
  assert.notEqual(notes.run({ TEST_GH_EXISTING_RELEASE: "1", TEST_GH_NOTES_FAIL: "1" }).status, 0);
  assert(!notes.calls().some((args) => args[1] === "upload"));
});
