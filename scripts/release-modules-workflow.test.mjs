import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/release-modules.yml", import.meta.url), "utf8");

test("module-only release builds every declared target and never invokes the core release workflow", () => {
  for (const platform of ["linux-x86_64", "windows-x86_64", "darwin-aarch64", "darwin-x86_64"]) {
    assert.match(workflow, new RegExp(platform));
  }
  assert.match(workflow, /cargo build --manifest-path src-tauri\/Cargo\.toml/);
  assert.match(workflow, /--prepare-catalog-update current-catalog changed-catalog next-catalog/);
  assert.match(workflow, /--sign-catalog next-catalog/);
  assert.doesNotMatch(workflow, /latest\.json/);
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
