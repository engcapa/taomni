import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { selectModulesForRelease } from "./detect-changed-modules.mjs";

const repoRoot = join(import.meta.dirname, "..");

function createRepoFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "taomni-detect-modules-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const addModule = (slug, version, platforms, status = "stable") => {
    mkdirSync(join(root, "src-tauri/plugins", slug), { recursive: true });
    writeFileSync(
      join(root, "src-tauri/plugins", slug, "module.json"),
      JSON.stringify({ id: `taomni-plugin-${slug}`, slug, name: slug, version, status, platforms }, null, 2) + "\n",
    );
    writeFileSync(
      join(root, "src-tauri/plugins", slug, "Cargo.toml"),
      `[package]\nname = "taomni-plugin-${slug}"\nversion = "${version}"\n`,
    );
  };
  addModule("mail", "0.1.59", ["linux-x86_64", "windows-x86_64"]);
  addModule("servers", "0.1.5", ["linux-x86_64", "windows-x86_64", "darwin-aarch64", "darwin-x86_64"]);
  addModule("vnc-server", "0.1.4", ["linux-x86_64", "windows-x86_64", "darwin-aarch64", "darwin-x86_64"]);
  addModule("hello-plugin", "0.9.0", ["linux-x86_64"], "provisional");
  return root;
}

const baselineCatalog = {
  plugins: {
    "taomni-plugin-mail": { id: "taomni-plugin-mail", version: "0.1.59" },
    "taomni-plugin-servers": { id: "taomni-plugin-servers", version: "0.1.4" },
    "taomni-plugin-vnc-server": { id: "taomni-plugin-vnc-server", version: "0.1.3" },
  },
};

test("auto-changed detects multiple updated stable modules, ignores provisional ones, and computes batch tag", (t) => {
  const root = createRepoFixture(t);
  const result = selectModulesForRelease({
    repoRoot: root,
    catalog: baselineCatalog,
    mode: "auto-changed",
    coreTag: "v0.6.1",
    runNumber: "88",
  });
  assert.deepEqual(result.modules, ["servers", "vnc-server"]);
  assert.equal(result.expectedPackages, 8);
  assert.equal(result.tag, "v0.6.1-modules.88");
  assert.match(result.summaryMarkdown, /`servers`/);
  assert.match(result.summaryMarkdown, /`vnc-server`/);
});

test("auto-changed uses single-module tag format when exactly one module changed, and includes brand new stable modules", (t) => {
  const root = createRepoFixture(t);
  const single = selectModulesForRelease({
    repoRoot: root,
    catalog: {
      plugins: {
        ...baselineCatalog.plugins,
        "taomni-plugin-vnc-server": { id: "taomni-plugin-vnc-server", version: "0.1.4" },
      },
    },
    mode: "auto-changed",
    coreTag: "v0.6.1",
    runNumber: "89",
  });
  assert.deepEqual(single.modules, ["servers"]);
  assert.equal(single.expectedPackages, 4);
  assert.equal(single.tag, "v0.1.5-servers");

  const withNew = selectModulesForRelease({
    repoRoot: root,
    catalog: { plugins: { "taomni-plugin-mail": { id: "taomni-plugin-mail", version: "0.1.59" } } },
    mode: "auto-changed",
    coreTag: "v0.6.1",
    runNumber: "90",
  });
  assert.deepEqual(withNew.modules, ["servers", "vnc-server"]);
});

test("auto-changed rejects zero changes and stale local checkouts behind published versions", (t) => {
  const root = createRepoFixture(t);
  assert.throws(() => selectModulesForRelease({
    repoRoot: root,
    catalog: {
      plugins: {
        "taomni-plugin-mail": { version: "0.1.59" },
        "taomni-plugin-servers": { version: "0.1.5" },
        "taomni-plugin-vnc-server": { version: "0.1.4" },
      },
    },
    mode: "auto-changed",
    coreTag: "v0.6.1",
  }), /No stable modules have a newer version/);

  assert.throws(() => selectModulesForRelease({
    repoRoot: root,
    catalog: {
      plugins: {
        ...baselineCatalog.plugins,
        "taomni-plugin-servers": { version: "0.1.6" },
      },
    },
    mode: "auto-changed",
    coreTag: "v0.6.1",
  }), /behind published catalog version/);
});

test("manual mode validates slugs, deduplicates, checks strict version increase, and enforces distinct SemVer tag", (t) => {
  const root = createRepoFixture(t);
  const manual = selectModulesForRelease({
    repoRoot: root,
    catalog: baselineCatalog,
    mode: "manual",
    manualModules: "vnc-server, servers",
    tag: "v0.6.1-hotfix.1",
    coreTag: "v0.6.1",
  });
  assert.deepEqual(manual.modules, ["servers", "vnc-server"]);
  assert.equal(manual.tag, "v0.6.1-hotfix.1");

  assert.throws(() => selectModulesForRelease({
    repoRoot: root,
    catalog: baselineCatalog,
    mode: "manual",
    manualModules: "mail",
    coreTag: "v0.6.1",
  }), /must be greater than published/);

  assert.throws(() => selectModulesForRelease({
    repoRoot: root,
    catalog: baselineCatalog,
    mode: "manual",
    manualModules: "servers,servers",
    coreTag: "v0.6.1",
  }), /Duplicate module slug/);

  assert.throws(() => selectModulesForRelease({
    repoRoot: root,
    catalog: baselineCatalog,
    mode: "manual",
    manualModules: "hello-plugin",
    coreTag: "v0.6.1",
  }), /Unknown or non-stable module slug/);

  assert.throws(() => selectModulesForRelease({
    repoRoot: root,
    catalog: baselineCatalog,
    mode: "manual",
    manualModules: "servers",
    tag: "v0.6.1",
    coreTag: "v0.6.1",
  }), /distinct from core tag/);
});

test("selectModulesForRelease validates against live repository manifests", () => {
  const result = selectModulesForRelease({
    repoRoot,
    catalog: { plugins: {} },
    mode: "auto-changed",
    coreTag: "v0.6.1",
    runNumber: "1",
  });
  assert.equal(result.modules.length, 10);
  assert.equal(result.tag, "v0.6.1-modules.1");
});
