import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listStableModules } from "./release-version-utils.mjs";

const repoRoot = join(import.meta.dirname, "..");
const workflow = readFileSync(new URL("../.github/workflows/release-modules.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("workflow_dispatch module input offers a dropdown matching every stable module", () => {
  const dispatchSection = workflow.split("  workflow_call:\n")[0];
  const moduleBlock = dispatchSection.split("      module:\n")[1].split("      head:\n")[0];
  assert.match(moduleBlock, /^        type: choice$/m);
  const options = [...moduleBlock.matchAll(/^          - (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(options, listStableModules(repoRoot).map((mod) => mod.slug));
});

test("module-only release builds every declared target and never invokes the core release workflow", () => {
  for (const platform of ["linux-x86_64", "windows-x86_64", "darwin-aarch64", "darwin-x86_64"]) {
    assert.match(workflow, new RegExp(platform));
  }
  assert.match(workflow, /cargo build --manifest-path src-tauri\/Cargo\.toml/);
  assert.match(workflow, /targets = \[target for target in targets if target\['platform'\] in declared\]/);
  assert.match(workflow, /--prepare-catalog-update current-catalog changed-catalog next-catalog/);
  assert.match(workflow, /--sign-catalog next-catalog/);
  assert.doesNotMatch(workflow, /gh release upload .*latest\.json/);
  assert.doesNotMatch(workflow, /tauri-apps\/tauri-action/);
});

test("reusable packaging keeps independent artifact names and skips standalone publication", () => {
  assert.match(workflow, /module-unsigned-\$\{\{ needs\.source\.outputs\.slug \}\}-/);
  assert.match(workflow, /module-signed-\$\{\{ needs\.source\.outputs\.slug \}\}-/);
  assert.match(workflow, /release-desktop-frontend-\$\{\{ needs\.source\.outputs\.slug \}\}-/);
  assert.match(workflow, /if: \$\{\{ !inputs\.package_only && needs\.source\.result == 'success'/);
  assert.match(workflow, /package_only and not tag and status == 'provisional'/);
  assert.match(workflow, /rehearsal = os\.environ\['PACKAGE_ONLY'\] == 'true' and not os\.environ\['RELEASE_TAG'\]\.strip\(\)/);
});

test("QA and release build Linux modules on the core glibc baseline and check the staged binaries", () => {
  const qa = readFileSync(new URL("../.github/workflows/qa-modular-packages.yml", import.meta.url), "utf8");
  for (const source of [qa, workflow]) {
    assert.match(source, /'os': 'ubuntu-22\.04', 'target': 'x86_64-unknown-linux-gnu', 'platform': 'linux-x86_64'/);
    assert.match(source, /bash scripts\/install-release-pipewire\.sh/);
    const signer = source.split("\n  sign:\n")[1];
    const baseline = signer.indexOf("python scripts/check_linux_module_abi.py");
    const key = signer.indexOf("TAURI_SIGNING_PRIVATE_KEY:");
    assert(baseline > 0 && baseline < key);
    assert.match(signer.slice(baseline, key), /path: linux-abi\.json/);
  }
});

test("module-only publication uploads immutable packages before the signed catalog", () => {
  const packages = workflow.indexOf("Upload changed packages before the signed catalog");
  const signature = workflow.indexOf("gh release upload \"$TAG\" next-catalog/modules.json.minisig");
  const catalog = workflow.indexOf("gh release upload \"$TAG\" next-catalog/modules.json --clobber");
  assert.ok(packages >= 0);
  assert.ok(packages < signature);
  assert.ok(signature < catalog);
  assert.match(workflow, /--verify-catalog current-catalog/);
  assert.match(workflow, /--verify-catalog next-catalog/);
});

test("signing checks the selected source SHA and trusted manifest", () => {
  assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(workflow, /candidate source identity does not match the selected commit/);
  assert.match(workflow, /only stable modules can enter a production catalog/);
});

test("the production Windows VNC archive owns the special-key helper", () => {
  const build = workflow.split("- name: Build the Windows VNC key helper\n")[1].split("- name:")[0];
  assert.match(build, /slug == 'vnc-client' && runner\.os == 'Windows'/);
  assert.match(build, /-p taomni-vnc-key-helper --bin taomni-vnc-key-helper/);
  assert.match(workflow, /helper = 'taomni-vnc-key-helper\.exe'\s+shutil\.copyfile\(binaries \/ helper, payload \/ helper\)/);
  assert.match(workflow, /candidate Windows VNC key helper is missing/);
});

test("the fixed macOS identity signs the host before the detached package signature", () => {
  const check = workflow.indexOf("Check candidate identity against the trusted manifest");
  const host = workflow.indexOf("Sign the macOS host before signing its module archive");
  const archive = workflow.indexOf("Sign and verify the immutable package");
  assert(check > 0 && check < host && host < archive);
  assert.match(workflow, /MACOS_SIGNING_CERT_SHA1: \$\{\{ vars\.MACOS_SIGNING_CERT_SHA1 \}\}/);
  assert.match(workflow, /always\(\) && env\.MACOS_SIGNING_WORK_DIR != ''/);
});

test("macOS module signing verifies the pinned host identity and records the assessment", (t) => {
  const root = mkdtempSync(join(tmpdir(), "taomni-module-signing-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const certificate = "test public certificate";
  const fingerprint = createHash("sha1").update(certificate).digest("hex").toUpperCase();
  const binary = join(root, "taomni-plugin-mail");
  const evidence = join(root, "evidence");
  const source = "b".repeat(40);
  writeFileSync(binary, "test executable");
  writeFileSync(join(root, "lipo"), "#!/usr/bin/env bash\nprintf 'arm64\\n'\n", { mode: 0o755 });
  writeFileSync(join(root, "spctl"), "#!/usr/bin/env bash\nprintf 'rejected\\n'\nexit 3\n", { mode: 0o755 });
  writeFileSync(join(root, "codesign"), `#!/usr/bin/env bash
case "$1" in
  --force) test "$5" = runtime ;;
  --verify) exit 0 ;;
  -d)
    case "$2" in
      --verbose=4) printf 'Identifier=com.taomni.module.mail\\nflags=0x10000(runtime)\\n' >&2 ;;
      --extract-certificates=*)
        prefix="$(printf '%s' "$2" | cut -d= -f2-)"
        printf '%s' "$TEST_CERTIFICATE" > "$prefix"0
        ;;
    esac
    ;;
esac
`, { mode: 0o755 });
  const signing = new URL("./sign-macos-module-host.sh", import.meta.url);
  const run = (pinned) => spawnSync("bash", [signing.pathname, binary, evidence], {
    cwd: root,
    env: { ...process.env, PATH: `${root}:${process.env.PATH}`, RUNNER_TEMP: root,
      MODULE_SLUG: "mail", MODULE_PLATFORM: "darwin-aarch64", MODULE_SOURCE_SHA: source,
      MACOS_SIGNING_MODE: "self-signed", MACOS_SIGNING_WORK_DIR: root,
      MACOS_SIGNING_CERT_SHA1: pinned, TEST_CERTIFICATE: certificate },
    encoding: "utf8",
  });
  assert.equal(run("A".repeat(40)).status, 1);
  const result = run(fingerprint);
  assert.equal(result.status, 0, result.stderr);
  const identity = readFileSync(join(evidence, "identity.txt"), "utf8");
  assert.match(identity, /gatekeeperExitCode=3/);
  assert(identity.includes("sourceSha=" + source));
});

test("authenticates the existing catalog before fetching its assets and signs the merged delta", () => {
  const baseline = workflow.indexOf("--verify-catalog-signature current-catalog");
  const download = workflow.indexOf("node scripts/fetch-published-module-assets.mjs current-catalog current-catalog");
  const complete = workflow.indexOf("--verify-catalog current-catalog");
  assert(baseline > 0 && baseline < download && download < complete);
  assert.match(workflow, /changed-modules changed-catalog --delta/);
  const signing = workflow.split("- name: Sign the complete module catalog\n")[1].split("- name:")[0];
  assert.match(signing, /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/);
  assert.match(signing, /--sign-catalog next-catalog/);
  const core = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  for (const source of [workflow.split("  publish:\n")[1], core.split("  finalize-updater-manifest:")[1]]) {
    assert.match(source, /group: taomni-release-catalog-publication/);
  }
});

const publicationScript = workflow.split("- name: Publish the module assets and update the core release catalog\n")[1]
  .split("        run: |\n")[1].split("      - uses:")[0].split("\n")
  .map((line) => line.slice(10)).join("\n");

function runPublication(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "taomni-module-release-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const trace = join(root, "trace.jsonl");
  writeFileSync(join(root, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_GH_TRACE, JSON.stringify(args) + "\\n");
if (args[1] === "view") console.log(process.env.TEST_LATEST_TAG || process.env.CORE_TAG);
if (args[3] === process.env.TEST_FAIL_UPLOAD) process.exit(1);
`, { mode: 0o755 });
  const result = spawnSync("bash", ["-c", publicationScript], {
    cwd: root,
    env: { ...process.env, PATH: `${root}:${process.env.PATH}`, TEST_GH_TRACE: trace,
      TAG: "v0.6.1-mail.1", CORE_TAG: "v0.6.1", ...overrides },
    encoding: "utf8",
  });
  return { result, calls: readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse) };
}

test("publishes the new module tag without changing the latest core release", (t) => {
  const { result, calls } = runPublication(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls[0], ["release", "edit", "v0.6.1-mail.1", "--draft=false", "--latest=false"]);
  assert.deepEqual(calls.slice(2).map((args) => args.slice(1)), [
    ["upload", "v0.6.1", "next-catalog/modules.json.minisig", "--clobber"],
    ["upload", "v0.6.1", "next-catalog/modules.json", "--clobber"],
  ]);
});

test("restores the previous catalog pair when an upload fails", (t) => {
  const { result, calls } = runPublication(t, { TEST_FAIL_UPLOAD: "next-catalog/modules.json" });
  assert.equal(result.status, 1);
  assert.deepEqual(calls.slice(-2).map((args) => args.slice(1)), [
    ["upload", "v0.6.1", "current-catalog/modules.json.minisig", "--clobber"],
    ["upload", "v0.6.1", "current-catalog/modules.json", "--clobber"],
  ]);
});

test("an unexpected latest core release stops the catalog upload", (t) => {
  const { result, calls } = runPublication(t, { TEST_LATEST_TAG: "v0.6.2" });
  assert.equal(result.status, 1);
  assert(!calls.some((args) => args[1] === "upload"));
});

test("read-only catalog rehearsal skips publication and verifies the delta without release writes", () => {
  const publishJob = workflow.split("\n  publish:\n")[1].split("\n  rehearse-catalog:\n")[0];
  assert.match(publishJob, /if: \$\{\{ !inputs\.package_only && needs\.source\.result == 'success' && needs\.sign\.result == 'success' && needs\.source\.outputs\.rehearsal_baseline_run == '' \}\}/);
  const coreWorkflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  for (const prod of [publishJob, coreWorkflow]) {
    assert.doesNotMatch(prod, /--rehearsal-allow-provisional|--rehearsal-first-release/);
  }

  const rehearsalJob = workflow.split("\n  rehearse-catalog:\n")[1];
  assert.ok(rehearsalJob, "Missing rehearse-catalog job");
  assert.match(rehearsalJob, /contents: read/);
  assert.match(rehearsalJob, /actions: read/);
  for (const needle of [
    "--rehearsal-first-release",
    "--delta",
    "--prepare-catalog-update current-catalog changed-catalog next-catalog --rehearsal-allow-provisional",
    "--verify-release-roster next-catalog current-catalog",
    "--sign-catalog next-catalog --rehearsal-allow-provisional",
    "--verify-catalog next-catalog --rehearsal-allow-provisional",
    "verify-module-catalog-delta.mjs",
  ]) {
    assert(rehearsalJob.includes(needle), `Missing rehearsal step marker: ${needle}`);
  }
  assert.doesNotMatch(rehearsalJob, /gh release (?:create|upload|edit)/);
});
