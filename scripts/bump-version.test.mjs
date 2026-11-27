import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyVersionBumps, planVersionBumps } from "./bump-version.mjs";
import { listStableModules } from "./release-version-utils.mjs";

const repoRoot = join(import.meta.dirname, "..");
const bumpWorkflow = readFileSync(new URL("../.github/workflows/bump-version.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function createRepoFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "taomni-bump-version-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src-tauri/plugins/servers"), { recursive: true });
  mkdirSync(join(root, "src-tauri/plugins/vnc-server"), { recursive: true });
  mkdirSync(join(root, "src-tauri/plugins/hello-plugin"), { recursive: true });

  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "taomni", version: "0.6.1", dependencies: { foo: "^1.0.0" } }, null, 2) + "\n");
  writeFileSync(
    join(root, "src-tauri/Cargo.toml"),
    `[package]\nname = "taomni"\nversion = "0.6.1"\n\n[dependencies]\nserde = { version = "1" }\n`,
  );
  writeFileSync(join(root, "src-tauri/Cargo.lock"), "# lock fixture\n");

  writeFileSync(
    join(root, "src-tauri/plugins/servers/module.json"),
    `{\n  "id": "taomni-plugin-servers",\n  "slug": "servers",\n  "name": "Local servers",\n  "version": "0.1.4",\n  "status": "stable",\n  "platforms": ["linux-x86_64", "windows-x86_64"]\n}\n`,
  );
  writeFileSync(
    join(root, "src-tauri/plugins/servers/Cargo.toml"),
    `[package]\nname = "taomni-plugin-servers"\nversion = "0.1.4"\n\n[dependencies]\nserde = "1"\n`,
  );

  writeFileSync(
    join(root, "src-tauri/plugins/vnc-server/module.json"),
    `{\n  "id": "taomni-plugin-vnc-server",\n  "slug": "vnc-server",\n  "name": "VNC Server",\n  "version": "0.1.3",\n  "status": "stable",\n  "platforms": ["linux-x86_64", "darwin-aarch64"]\n}\n`,
  );
  writeFileSync(
    join(root, "src-tauri/plugins/vnc-server/Cargo.toml"),
    `[package]\nname = "taomni-plugin-vnc-server"\nversion = "0.1.3"\n\n[dependencies]\nserde = "1"\n`,
  );

  writeFileSync(
    join(root, "src-tauri/plugins/hello-plugin/module.json"),
    `{\n  "id": "taomni-plugin-hello-plugin",\n  "slug": "hello-plugin",\n  "version": "0.1.0",\n  "status": "provisional",\n  "platforms": ["linux-x86_64"]\n}\n`,
  );
  writeFileSync(join(root, "src-tauri/plugins/hello-plugin/Cargo.toml"), `[package]\nname = "taomni-hello-plugin"\nversion = "0.1.0"\n`);
  return root;
}

test("bump-version workflow dropdown matches every stable module plus core and batch-custom", () => {
  const stableSlugs = listStableModules(repoRoot).map((mod) => mod.slug);
  const block = bumpWorkflow.split("      target:\n")[1].split("      bump:\n")[0];
  const options = [...block.matchAll(/^          - (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(options, ["core", ...stableSlugs, "batch-custom"]);
  assert.match(bumpWorkflow, /contents: write/);
  assert.match(bumpWorkflow, /pull-requests: write/);
  assert.match(bumpWorkflow, /node scripts\/bump-version\.mjs/);
  assert.match(bumpWorkflow, /gh pr create/);
  assert.doesNotMatch(bumpWorkflow, /gh pr merge/);
});

test("bumps core patch/minor/major/explicit and syncs Cargo.lock offline with --locked check", (t) => {
  const root = createRepoFixture(t);
  const calls = [];
  const plan = planVersionBumps({ repoRoot: root, target: "core", bump: "patch", today: "2026-11-27" });
  assert.equal(plan.branch, "chore/bump-core-0.6.2");
  assert.equal(plan.title, "chore(release): bump core to 0.6.2");
  assert.match(plan.body, /Release Bundle.*v0\.6\.2/);

  applyVersionBumps({ repoRoot: root, plan, runCargo: (_cwd, args) => calls.push(args) });
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "0.6.2");
  assert.match(readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8"), /version = "0\.6\.2"/);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ["update", "--manifest-path", join(root, "src-tauri/Cargo.toml"), "--offline", "-p", "taomni"]);
  assert.deepEqual(calls[1], ["metadata", "--manifest-path", join(root, "src-tauri/Cargo.toml"), "--locked", "--offline", "--format-version", "1"]);

  assert.equal(planVersionBumps({ repoRoot: root, target: "core", bump: "minor" }).entries[0].nextVersion, "0.7.0");
  assert.equal(planVersionBumps({ repoRoot: root, target: "core", bump: "major" }).entries[0].nextVersion, "1.0.0");
  assert.equal(planVersionBumps({ repoRoot: root, target: "core", bump: "explicit", explicitVersion: "0.6.5" }).entries[0].nextVersion, "0.6.5");
});

test("bumps single module preserving inline JSON formatting and non-package Cargo sections", (t) => {
  const root = createRepoFixture(t);
  const calls = [];
  const plan = planVersionBumps({ repoRoot: root, target: "servers", bump: "patch", today: "2026-11-27" });
  assert.equal(plan.branch, "chore/bump-servers-0.1.5");
  assert.match(plan.body, /Release Modules Batch.*auto-changed/);
  assert.match(plan.body, /Release Module Catalog.*v0\.1\.5-servers/);

  applyVersionBumps({ repoRoot: root, plan, runCargo: (_cwd, args) => calls.push(args) });
  const jsonText = readFileSync(join(root, "src-tauri/plugins/servers/module.json"), "utf8");
  assert.match(jsonText, /"version": "0\.1\.5"/);
  assert.match(jsonText, /"platforms": \["linux-x86_64", "windows-x86_64"\]/);
  const cargoText = readFileSync(join(root, "src-tauri/plugins/servers/Cargo.toml"), "utf8");
  assert.match(cargoText, /version = "0\.1\.5"\n\n\[dependencies\]\nserde = "1"/);
  assert.deepEqual(calls[0], ["update", "--manifest-path", join(root, "src-tauri/Cargo.toml"), "--offline", "-p", "taomni-plugin-servers"]);
});

test("supports batch-custom and core+modules combined bumps", (t) => {
  const root = createRepoFixture(t);
  const batch = planVersionBumps({
    repoRoot: root,
    target: "batch-custom",
    bump: "patch",
    extraBumps: "servers=patch, vnc-server=0.1.5",
    today: "2026-11-27",
  });
  assert.equal(batch.branch, "chore/bump-modules-20261127");
  assert.equal(batch.entries.map((e) => `${e.target}@${e.nextVersion}`).join(","), "servers@0.1.5,vnc-server@0.1.5");
  assert.match(batch.body, /Release Modules Batch.*auto-changed/);

  const joint = planVersionBumps({
    repoRoot: root,
    target: "core",
    bump: "patch",
    extraBumps: "servers=patch",
    today: "2026-11-27",
  });
  assert.equal(joint.branch, "chore/bump-release-0.6.2-modules");
  assert.match(joint.body, /modules.*servers/);
});

test("rejects downgrades, duplicates, provisional modules, and missing explicit versions", (t) => {
  const root = createRepoFixture(t);
  assert.throws(() => planVersionBumps({ repoRoot: root, target: "core", bump: "explicit", explicitVersion: "0.6.1" }), /must be greater/);
  assert.throws(() => planVersionBumps({ repoRoot: root, target: "core", bump: "explicit", explicitVersion: "0.6.0" }), /must be greater/);
  assert.throws(() => planVersionBumps({ repoRoot: root, target: "core", bump: "explicit", explicitVersion: "" }), /requires a concrete version/);
  assert.throws(() => planVersionBumps({ repoRoot: root, target: "servers", bump: "patch", extraBumps: "servers=minor" }), /Duplicate/);
  assert.throws(() => planVersionBumps({ repoRoot: root, target: "hello-plugin", bump: "patch" }), /Unknown or non-stable/);
  assert.throws(() => planVersionBumps({ repoRoot: root, target: "batch-custom", bump: "patch", extraBumps: "" }), /requires non-empty extra_bumps/);
});
