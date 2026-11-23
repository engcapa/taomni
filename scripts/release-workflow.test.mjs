import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const workflow = readFileSync(fileURLToPath(new URL("../.github/workflows/release.yml", import.meta.url)), "utf8").replace(/\r\n/g, "\n");
const coreAction = readFileSync(new URL("../.github/actions/stage-core-updater/action.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const coreScript = coreAction.split("      run: |\n")[1];
test("the Windows base excludes SocksCap and desktop installers retain their platform resources", () => {
  const config = (target = "") => JSON.parse(readFileSync(new URL(`../src-tauri/tauri${target}.conf.json`, import.meta.url), "utf8"));
  assert.deepEqual(config().bundle.resources, ["resources/licenses/*"]);
  // README keeps the globs nonempty before optional development staging.
  assert.deepEqual(config(".linux").bundle.resources, [
    "resources/licenses/*",
    "resources/sockscap/linux/README.md",
  ]);
  assert.deepEqual(config(".windows").bundle.resources, [
    "resources/licenses/*",
  ]);
  assert.deepEqual(config(".macos").bundle.resources, [
    "resources/licenses/*",
    "resources/sockscap/macos/[Rs]*",
  ]);
});
test("macOS native tests and bundles share a deployment target supporting Whisper filesystem APIs", () => {
  const config = JSON.parse(readFileSync(fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url)), "utf8"));
  const macosJob = workflow.split("  build-macos:\n")[1].split("    steps:\n")[0];
  const target = macosJob.match(/MACOSX_DEPLOYMENT_TARGET: "([\d.]+)"/)?.[1];
  assert.equal(target, config.bundle.macOS.minimumSystemVersion);
  const [major, minor = 0] = target.split(".").map(Number);
  assert(major > 10 || (major === 10 && minor >= 15), "Whisper requires macOS 10.15 or newer");
});
test("artifact-only selection controls builders and cannot enter the publishing job", () => {
  assert(workflow.includes("    if: needs.plan.outputs.build_desktop == 'true'"));
  assert(workflow.includes("        platform: ${{ fromJSON(needs.plan.outputs.desktop_platforms) }}"));
  assert(workflow.includes("    if: needs.plan.outputs.macos_architectures != '[]'"));
  const finalizer = workflow.split("  finalize-updater-manifest:\n")[1];
  assert(finalizer.includes("    needs: [plan, build, build-macos, package-modules]"));
  assert.match(finalizer, /needs\.plan\.outputs\.tag != ''/);
  assert.equal((workflow.match(/RELEASE_TEST_VERSION: \$\{\{ needs.plan.outputs.test_version \}\}/g) ?? []).length, 2);
  const mac = workflow.split("  build-macos:\n")[1].split("  package-modules:\n")[0];
  assert(mac.includes("arch: ${{ fromJSON(needs.plan.outputs.macos_architectures) }}"));
  assert(mac.includes("if: matrix.arch == 'aarch64' && inputs.macos_static_krb5"));
  assert(mac.includes("MACOS_STATIC_KRB5: ${{ matrix.arch == 'aarch64' && inputs.macos_static_krb5 }}"));
  assert(mac.includes("args: --target ${{ matrix.arch }}-apple-darwin"));
  assert(mac.includes("name: taomni-${{ needs.plan.outputs.version }}-macos-${{ matrix.arch }}"));
  assert(mac.includes("bash scripts/verify-macos-release-bundle.sh \"$TARGET\" \"$EXPECTED_ARCH\""));
});

test("joint releases queue every selected module from the same source and require all package jobs", () => {
  const pack = workflow.split("  package-modules:\n")[1].split("  verify-candidate-roster:\n")[0];
  assert.match(pack, /^      fail-fast: false$/m);
  assert.doesNotMatch(pack, /^\s*max-parallel:/m, "schedule all module jobs as runners become available");
  assert.match(pack, /module: \$\{\{ fromJSON\(needs\.plan\.outputs\.modules\) \}\}/);
  assert.match(pack, /head: \$\{\{ github\.sha \}\}/);
  assert.match(pack, /uses: \.\/\.github\/workflows\/release-modules\.yml/);
  assert.match(pack, /package_only: true/);
  const finalizer = workflow.split("  finalize-updater-manifest:\n")[1];
  assert.match(finalizer, /needs\.package-modules\.result == 'success'/);
  assert.match(finalizer, /needs\.plan\.outputs\.modules == '\[\]' && needs\.package-modules\.result == 'skipped'/);
});

test("joint builds download core bundles and signed module packages from their respective builders", () => {
  const version = "0.6.0";
  const runId = "42";
  const corePattern = coreAction.match(/pattern: (.+)/)[1].replace("${{ inputs.version }}", version);
  const finalizer = workflow.split("  finalize-updater-manifest:\n")[1];
  const modulePattern = finalizer.match(/pattern: (.+)/)[1].replace("${{ github.run_id }}", runId);
  const core = ["windows-latest", "ubuntu-22.04", "macos-aarch64", "macos-x86_64"].map((target) => `taomni-${version}-${target}`);
  const signed = ["module-signed-mail-darwin-x86_64-42", "module-signed-rdp-server-linux-x86_64-42"];
  const artifacts = [...core, ...signed, "module-unsigned-mail-darwin-x86_64-42", "module-linux-abi-mail-42",
    "taomni-0.5.12-ubuntu-22.04", "macos-bundle-diagnostics-aarch64-42", "modular-candidate-updater-42"];
  assert.deepEqual(artifacts.filter((name) => matchesGlob(name, corePattern)), core);
  assert.deepEqual(artifacts.filter((name) => matchesGlob(name, modulePattern)), signed);
  assert(coreAction.includes("path: core-bundles"));
  assert(coreAction.includes("merge-multiple: false"));
  assert(finalizer.includes("path: signed-module-artifacts"));
  assert(finalizer.includes("compose-modules-manifest.mjs signed-module-artifacts changed-module-catalog --delta"));
  assert(finalizer.includes("compose-modules-manifest.mjs signed-module-artifacts module-assets --first-release"));
  const rehearsal = workflow.split("  verify-candidate-updater:\n")[1].split("  finalize-updater-manifest:\n")[0];
  for (const job of [rehearsal, finalizer]) assert(job.includes("uses: ./.github/actions/stage-core-updater"));
  assert(rehearsal.includes("contents: read") && rehearsal.includes("needs.plan.outputs.tag == ''"));
  assert(rehearsal.includes("inputs.platforms == 'all' && inputs.macos_arch == 'both'"));
});

test("candidate publication bypasses compilation and verifies exact prior artifacts before upload", () => {
  for (const name of ["build", "build-macos", "package-modules"]) {
    assert.match(workflow.split(`  ${name}:\n`)[1].split("    steps:")[0], /if: .*candidate_run == ''/);
  }
  const finalizer = workflow.split("  finalize-updater-manifest:\n")[1];
  const select = finalizer.indexOf("verify-release-candidate.mjs select");
  const verify = finalizer.indexOf("verify-release-candidate.mjs verify");
  const publish = finalizer.indexOf("name: Verify and publish release assets");
  assert(select > 0 && select < verify && verify < publish);
  assert.match(finalizer, /artifact-ids: \$\{\{ steps\.candidate\.outputs\.module_artifacts \}\}/);
  assert.match(finalizer, /artifact-ids: \$\{\{ steps\.candidate\.outputs\.updater_artifact \}\}/);
  assert.match(coreAction, /artifact-ids: \$\{\{ inputs\.core_artifacts \}\}/);
  assert.match(coreAction, /run-id: \$\{\{ inputs\.candidate_run \}\}/);
});
const publishStep = workflow.split("      - name: Verify and publish release assets\n")[1];
assert(publishStep, "the tested publishing step must exist in release.yml");
const publishScript = publishStep.split("        run: |\n")[1].split("\n")
  .map((line) => line.startsWith("          ") ? line.slice(10) : line).join("\n");

test("checks the previously published first-upgrade roster before signing new catalogs", () => {
  const stage = workflow.indexOf("node scripts/stage-published-module-catalog.mjs carried-module-catalog --allow-missing");
  const assemble = workflow.indexOf("node scripts/compose-modules-manifest.mjs signed-module-artifacts module-assets");
  const verify = workflow.indexOf('--verify-release-roster module-assets "${previous[@]}"');
  const sign = workflow.indexOf("--sign-catalog module-assets");
  assert(stage > 0 && stage < assemble && assemble < verify && verify < sign);
  const verifyPrevious = workflow.indexOf("--verify-catalog-signature carried-module-catalog");
  const fetch = workflow.indexOf("node scripts/fetch-published-module-assets.mjs carried-module-catalog carried-module-catalog");
  const merge = workflow.indexOf("--prepare-catalog-update carried-module-catalog changed-module-catalog module-assets");
  assert(assemble < verifyPrevious && verifyPrevious < fetch && fetch < merge && merge < verify);
  const verificationStep = workflow.slice(workflow.indexOf("      - name: Verify the first-upgrade roster before signing"), verify);
  assert(verificationStep.includes("previous+=(carried-module-catalog)"));
  assert(!verificationStep.includes("TAURI_SIGNING_PRIVATE_KEY"));
});

function fixture(t, tag = "v0.4.30") {
  const root = mkdtempSync(join(tmpdir(), "taomni-release-workflow-unit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, bytes) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };
  for (const name of ["compose-updater-manifest.mjs", "compose-modules-manifest.mjs", "verify-updater-signatures.mjs"]) {
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
    const path = join(root, "core-bundles", `taomni-${version}-${platform}`, name);
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
    put(join(root, "core-bundles", `taomni-${version}-macos-${arch}`, `Taomni_${version}_${arch}.dmg`), `${arch} installer bytes`);
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
    ...process.env, PATH: `${dirname(gh)}:${process.env.PATH}`,
    TAG: tag, GH_REPO: "engcapa/taomni", GITHUB_REPOSITORY: "engcapa/taomni", GITHUB_SHA: "fixture-commit",
    TEST_GH_TRACE: trace, RELEASE_NOTES: "",
  };
  return {
    root, signedPaths,
    put,
    calls: () => existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse) : [],
    run: (overrides = {}) => spawnSync("bash", ["-ec", coreScript + "\n" + publishScript], { cwd: root, env: { ...env, ...overrides }, encoding: "utf8" }),
  };
}

test("verifies the detached module catalog and all its packages before any release mutation", (t) => {
  const f = fixture(t);
  f.put(join(f.root, "module-assets/modules.json"), "staged catalog");
  assert.notEqual(f.run().status, 0);
  assert.deepEqual(f.calls(), []);
  rmSync(join(f.root, "updater-assets"), { recursive: true });
  const verifier = join(f.root, "scripts/plugin-package/target/release/taomni-plugin-package");
  f.put(verifier, '#!/bin/sh\n[ "$1" = "--verify-catalog" ] && [ "$2" = "module-assets" ] && [ -f module-assets/modules.json.minisig ]\n');
  chmodSync(verifier, 0o755);
  assert.notEqual(f.run().status, 0);
  assert.deepEqual(f.calls(), []);
  rmSync(join(f.root, "updater-assets"), { recursive: true });
  f.put(join(f.root, "module-assets/modules.json.minisig"), "verified exact catalog signature");
  f.put(join(f.root, "module-assets/modules.json"), "{}");
  f.put(join(f.root, "module-assets/example.taomni-plugin"), "fixture only");
  f.put(join(f.root, "module-assets/example.taomni-plugin.minisig"), "fixture only");
  const checksumFile = join(f.root, "module-assets/SHA256SUMS");
  f.put(checksumFile, `${"0".repeat(64)}  example.taomni-plugin\n`);
  assert.notEqual(f.run().status, 0);
  assert.deepEqual(f.calls(), []);
  rmSync(join(f.root, "updater-assets"), { recursive: true });
  f.put(checksumFile, `${createHash("sha256").update("fixture only").digest("hex")}  example.taomni-plugin\n`);
  const result = f.run({ TEST_GH_EXISTING_DRAFT: "1" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const published = f.calls().filter((args) => args[1] === "upload").slice(-6).map((args) => args[3]);
  assert.deepEqual(published, ["module-assets/example.taomni-plugin", "module-assets/example.taomni-plugin.minisig",
    "module-assets/SHA256SUMS", "module-assets/modules.json.minisig", "module-assets/modules.json", "updater-assets/latest.json"]);
});

test("a joint release publishes only changed module assets from the verified catalog", (t) => {
  const f = fixture(t);
  const verifier = join(f.root, "scripts/plugin-package/target/release/taomni-plugin-package");
  f.put(verifier, '#!/bin/sh\n[ "$1" = "--verify-catalog" ] && [ "$2" = "module-assets" ]\n');
  chmodSync(verifier, 0o755);
  for (const name of [
    "unchanged.taomni-plugin", "unchanged.taomni-plugin.minisig",
    "changed.taomni-plugin", "changed.taomni-plugin.minisig", "modules.json", "modules.json.minisig",
  ]) {
    f.put(join(f.root, "module-assets", name), name);
  }
  f.put(join(f.root, "module-assets/modules.json"), JSON.stringify({
    releaseExceptions: { "taomni-plugin-mobile": { placement: "core", notes: "Mobile remains in the core application." } },
  }));
  f.put(join(f.root, "module-uploads.json"), JSON.stringify(["changed.taomni-plugin", "changed.taomni-plugin.minisig"]));
  f.put(join(f.root, "module-assets/SHA256SUMS"), `${createHash("sha256").update("changed.taomni-plugin").digest("hex")}  changed.taomni-plugin\n`);
  assert.notEqual(f.run({ TEST_GH_EXISTING_RELEASE: "1" }).status, 0);
  assert(f.calls().every((args) => args[1] === "view"));
  rmSync(join(f.root, "updater-assets"), { recursive: true });
  const result = f.run({ TEST_GH_EXISTING_DRAFT: "1" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const uploads = f.calls().filter((args) => args[1] === "upload").map((args) => args[3]);
  assert(!uploads.some((path) => path.includes("unchanged.taomni-plugin")));
  assert.deepEqual(uploads.slice(-6), [
    "module-assets/changed.taomni-plugin",
    "module-assets/changed.taomni-plugin.minisig",
    "module-assets/SHA256SUMS",
    "module-assets/modules.json.minisig",
    "module-assets/modules.json",
    "updater-assets/latest.json",
  ]);
  assert.match(readFileSync(join(f.root, "module-release-notes.md"), "utf8"),
    /Release notes with literal \$\(content\)\n\nMobile remains in the core application\./);
  assert.deepEqual(f.calls().at(-2), ["release", "edit", "v0.4.30", "--notes-file", "module-release-notes.md"]);
});

test("validates and carries the signed catalog before a core-only release becomes visible", (t) => {
  const f = fixture(t, "v0.6.2");
  const verifier = join(f.root, "scripts/plugin-package/target/release/taomni-plugin-package");
  f.put(verifier, '#!/bin/sh\n[ "$1" = "--verify-catalog-signature" ] && [ "$2" = "carried-module-catalog" ] && [ -f carried-module-catalog/modules.json.minisig ]\n');
  chmodSync(verifier, 0o755);
  f.put(join(f.root, "carried-module-catalog/modules.json"), "{}");
  const env = { MODULE_CATALOG_SOURCE_TAG: "v0.6.1", TEST_GH_EXISTING_DRAFT: "1" };
  assert.notEqual(f.run(env).status, 0);
  assert.deepEqual(f.calls(), []);
  rmSync(join(f.root, "updater-assets"), { recursive: true });
  f.put(join(f.root, "carried-module-catalog/modules.json.minisig"), "exact detached signature");
  const result = f.run(env);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const calls = f.calls();
  const uploads = calls.filter((args) => args[1] === "upload").map((args) => args[3]);
  assert.deepEqual(uploads.slice(-3), ["carried-module-catalog/modules.json.minisig",
    "carried-module-catalog/modules.json", "updater-assets/latest.json"]);
  assert.deepEqual(calls.at(-1), ["release", "edit", "v0.6.2", "--draft=false"]);
});

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
    if (failure === "missing installer") rmSync(join(f.root, "core-bundles/taomni-0.4.30-macos-aarch64/Taomni_0.4.30_aarch64.dmg"));
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
