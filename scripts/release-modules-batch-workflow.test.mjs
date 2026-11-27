import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/release-modules-batch.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("batch workflow plans auto-changed or manual modules, fans out via package_only, and merges once under the publication lock", () => {
  assert.match(workflow, /options:\n\s+- auto-changed\n\s+- manual/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/release-modules\.yml/);
  assert.match(workflow, /package_only: true/);
  assert.match(workflow, /matrix:\n\s+module: \$\{\{ fromJSON\(needs\.plan\.outputs\.modules\) \}\}/);
  for (const secret of [
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_SIGNING_IDENTITY",
  ]) {
    assert(workflow.includes(`${secret}: \${{ secrets.${secret} }}`), `Missing secret forwarding for ${secret}`);
  }

  const publishJob = workflow.split("\n  publish:\n")[1];
  assert.match(publishJob, /group: taomni-release-catalog-publication/);
  assert.match(publishJob, /pattern: module-signed-\*-\$\{\{ github\.run_id \}\}/);
  assert.match(publishJob, /test "\$actual" = "\$EXPECTED_PACKAGES"/);
  assert.match(publishJob, /changed-modules changed-catalog --delta/);
  assert.match(publishJob, /--prepare-catalog-update current-catalog changed-catalog next-catalog/);
  assert.match(publishJob, /--verify-release-roster next-catalog current-catalog/);
  assert.match(publishJob, /--sign-catalog next-catalog/);
  assert.match(publishJob, /--verify-catalog next-catalog/);
  assert.doesNotMatch(publishJob, /--rehearsal-allow-provisional|--rehearsal-first-release/);
  assert.doesNotMatch(workflow, /gh release upload .*latest\.json/);
  assert.doesNotMatch(workflow, /tauri-apps\/tauri-action/);
});

const publicationScript = workflow
  .split("- name: Publish the batch module assets and update the core release catalog\n")[1]
  .split("        run: |\n")[1]
  .split("      - uses:")[0]
  .split("\n")
  .map((line) => line.slice(10))
  .join("\n");

function runBatchPublication(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "taomni-batch-module-release-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const trace = join(root, "trace.jsonl");
  writeFileSync(
    join(root, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_GH_TRACE, JSON.stringify(args) + "\\n");
if (args[1] === "view") console.log(process.env.TEST_LATEST_TAG || process.env.CORE_TAG);
if (args[3] === process.env.TEST_FAIL_UPLOAD) process.exit(1);
`,
    { mode: 0o755 },
  );
  const result = spawnSync("bash", ["-c", publicationScript], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      TEST_GH_TRACE: trace,
      TAG: "v0.6.1-modules.42",
      CORE_TAG: "v0.6.1",
      ...overrides,
    },
    encoding: "utf8",
  });
  return { result, calls: readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse) };
}

test("publishes the batch tag without replacing latest and updates the core catalog", (t) => {
  const { result, calls } = runBatchPublication(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls[0], ["release", "edit", "v0.6.1-modules.42", "--draft=false", "--latest=false"]);
  assert.deepEqual(
    calls.slice(2).map((args) => args.slice(1)),
    [
      ["upload", "v0.6.1", "next-catalog/modules.json.minisig", "--clobber"],
      ["upload", "v0.6.1", "next-catalog/modules.json", "--clobber"],
    ],
  );
});

test("restores the prior catalog on failed upload and aborts if latest core changed mid-run", (t) => {
  const failed = runBatchPublication(t, { TEST_FAIL_UPLOAD: "next-catalog/modules.json" });
  assert.equal(failed.result.status, 1);
  assert.deepEqual(
    failed.calls.slice(-2).map((args) => args.slice(1)),
    [
      ["upload", "v0.6.1", "current-catalog/modules.json.minisig", "--clobber"],
      ["upload", "v0.6.1", "current-catalog/modules.json", "--clobber"],
    ],
  );

  const race = runBatchPublication(t, { TEST_LATEST_TAG: "v0.6.2" });
  assert.equal(race.result.status, 1);
  assert(!race.calls.some((args) => args[1] === "upload"));
});
