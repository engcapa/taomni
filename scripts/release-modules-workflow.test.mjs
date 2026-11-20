import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/release-modules.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("module-only release builds every declared target and never invokes the core release workflow", () => {
  for (const platform of ["linux-x86_64", "windows-x86_64", "darwin-aarch64", "darwin-x86_64"]) {
    assert.match(workflow, new RegExp(platform));
  }
  assert.match(workflow, /cargo build --manifest-path src-tauri\/Cargo\.toml/);
  assert.match(workflow, /--prepare-catalog-update current-catalog changed-catalog next-catalog/);
  assert.match(workflow, /--sign-catalog next-catalog/);
  assert.doesNotMatch(workflow, /gh release upload .*latest\.json/);
  assert.doesNotMatch(workflow, /tauri-apps\/tauri-action/);
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
