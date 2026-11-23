import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { releaseBuildPlan, rehearsesFirstUpgrade, selectPublicationModules, validateTestVersion } from "./resolve-release-build.mjs";

const version = "0.4.30";
const manual = { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF_TYPE: "branch" };

test("the default manual build collects all platforms without publishing", () => {
  assert.deepEqual(releaseBuildPlan(manual, version), {
    version, tag: "", test_version: "", build_desktop: "true", desktop_platforms: '["ubuntu-22.04","windows-latest"]',
    macos_architectures: '["aarch64","x86_64"]', macos_runner: "macos-15", modules: "[]", candidate_run: "",
  });
});

test("Intel-only upgrade tests resolve distinct versions without enabling releases", () => {
  for (const testVersion of ["0.4.31-permission.1", "0.4.31-permission.2"]) {
    const plan = releaseBuildPlan({ ...manual, INPUT_PLATFORMS: "macos", INPUT_MACOS_ARCH: "x86_64", RELEASE_TEST_VERSION: testVersion }, version);
    assert.deepEqual(plan, {
      version: testVersion, tag: "", test_version: testVersion, build_desktop: "false", desktop_platforms: "[]",
      macos_architectures: '["x86_64"]', macos_runner: "macos-15", modules: "[]", candidate_run: "",
    });
  }
  const arm = releaseBuildPlan({ ...manual, INPUT_MACOS_ARCH: "aarch64" }, version);
  assert.deepEqual(JSON.parse(arm.macos_architectures), ["aarch64"]);
});

test("Windows-only upgrade tests build one MSI target and never enter release publication", () => {
  const plan = releaseBuildPlan({ ...manual, INPUT_PLATFORMS: "windows" }, version);
  assert.equal(plan.tag, "");
  assert.equal(plan.build_desktop, "true");
  assert.deepEqual(JSON.parse(plan.desktop_platforms), ["windows-latest"]);
  assert.deepEqual(JSON.parse(plan.macos_architectures), []);
  assert.throws(() => releaseBuildPlan({ ...manual, INPUT_PLATFORMS: "windows", INPUT_RELEASE_TAG: `v${version}` }, version), /every platform/);
});

test("the static ARM64 rehearsal can share a run with other targets", () => {
  const rehearsal = { ...manual, INPUT_MACOS_STATIC_KRB5: "true" };
  for (const platforms of ["all", "macos"]) {
    for (const arch of ["both", "aarch64"]) {
      const plan = releaseBuildPlan({ ...rehearsal, INPUT_PLATFORMS: platforms, INPUT_MACOS_ARCH: arch }, version);
      assert.deepEqual(JSON.parse(plan.macos_architectures), arch === "both" ? ["aarch64", "x86_64"] : ["aarch64"]);
      assert.equal(plan.build_desktop, String(platforms === "all"));
    }
  }
  for (const overrides of [{ INPUT_PLATFORMS: "windows" }, { INPUT_MACOS_ARCH: "x86_64" }, { INPUT_RELEASE_TAG: `v${version}` }]) {
    assert.throws(() => releaseBuildPlan({ ...rehearsal, ...overrides }, version), /artifact-only build that includes macOS ARM64/);
  }
});

test("macOS 26 is available for test artifacts", () => {
  const plan = releaseBuildPlan({ ...manual, INPUT_MACOS_RUNNER: "macos-26" }, version);
  assert.equal(plan.macos_runner, "macos-26");
  assert.equal(plan.tag, "");
  assert.throws(() => releaseBuildPlan({ ...manual, INPUT_MACOS_RUNNER: "macos-latest" }, version), /Unsupported macOS/);
});

test("tag pushes and published releases keep the full build, ignoring manual inputs", () => {
  for (const event of [
    { GITHUB_EVENT_NAME: "push", GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.4.30" },
    { GITHUB_EVENT_NAME: "release", RELEASE_EVENT_TAG: "v0.4.30" },
  ]) {
    const plan = releaseBuildPlan({ ...event, INPUT_PLATFORMS: "macos", INPUT_MACOS_ARCH: "x86_64", INPUT_MACOS_RUNNER: "macos-26", RELEASE_TEST_VERSION: "0.4.31-test.1" }, version);
    assert.equal(plan.tag, "v0.4.30");
    assert.equal(plan.version, version);
    assert.equal(plan.macos_runner, "macos-15");
    assert.equal(plan.build_desktop, "true");
    assert.deepEqual(JSON.parse(plan.macos_architectures), ["aarch64", "x86_64"]);
  }
});

test("manual joint builds select only the named module packages", () => {
  const requested = { ...manual, INPUT_RELEASE_MODULES: "mfa, rdp-server" };
  assert.deepEqual(JSON.parse(releaseBuildPlan(requested, version).modules), ["mfa", "rdp-server"]);
  assert.equal(releaseBuildPlan(requested, version).tag, "");
  assert.equal(releaseBuildPlan({ ...requested, INPUT_RELEASE_TAG: `v${version}` }, version).tag, `v${version}`);
  for (const modules of ["../mfa", "mfa,mfa", "mfa,", "MFA", "mfa\nNAME=bad"]) {
    assert.throws(() => releaseBuildPlan({ ...manual, INPUT_RELEASE_MODULES: modules }, version), /unique module slugs/);
  }
});

test("the first tagged build automatically selects the complete monolith upgrade roster", () => {
  const tagged = releaseBuildPlan({ ...manual, INPUT_RELEASE_TAG: `v${version}` }, version);
  const slugs = JSON.parse(selectPublicationModules(tagged, () => undefined).modules);
  assert(!rehearsesFirstUpgrade({ ...tagged, modules: JSON.stringify(slugs) }));
  assert(rehearsesFirstUpgrade({ tag: "", modules: JSON.stringify([...slugs].reverse()) }));
  assert(!rehearsesFirstUpgrade({ tag: "", modules: JSON.stringify(slugs.slice(1)) }));
  assert.deepEqual(slugs, ["ai-voice-local", "mail", "mfa", "rdp-client", "rdp-server", "screenshot", "servers", "sockscap", "vnc-client", "vnc-server"]);
  for (const slug of slugs) {
    const manifest = JSON.parse(readFileSync(new URL(`../src-tauri/plugins/${slug}/module.json`, import.meta.url), "utf8"));
    assert.equal(manifest.id, `taomni-plugin-${slug}`);
    assert.ok(manifest.description.trim());
  }
  assert.throws(() => selectPublicationModules({ ...tagged, modules: '["mail"]' }, () => undefined), /must build all/);
  const complete = { ...tagged, modules: JSON.stringify([...slugs].reverse()) };
  assert.deepEqual(JSON.parse(selectPublicationModules(complete, () => undefined).modules), slugs);
  assert.equal(selectPublicationModules(tagged, () => "v0.6.0").modules, "[]");
  assert.equal(selectPublicationModules({ ...tagged, modules: '["mail"]' }, () => "v0.6.0").modules, '["mail"]');
  const rehearsal = releaseBuildPlan(manual, version);
  assert.equal(selectPublicationModules(rehearsal, () => assert.fail("unexpected public release lookup")), rehearsal);
});

test("manual releases forbid partial builds and test versions before any bundles are built", () => {
  const env = { ...manual, INPUT_RELEASE_TAG: "v0.4.30" };
  assert.equal(releaseBuildPlan(env, version).tag, "v0.4.30");
  assert.throws(() => releaseBuildPlan({ ...env, INPUT_PLATFORMS: "macos" }, version), /every platform/);
  assert.throws(() => releaseBuildPlan({ ...env, INPUT_MACOS_ARCH: "x86_64" }, version), /both macOS/);
  assert.equal(releaseBuildPlan({ ...env, INPUT_MACOS_RUNNER: "macos-26" }, version).macos_runner, "macos-15");
  assert.throws(() => releaseBuildPlan({ ...env, RELEASE_TEST_VERSION: "0.4.31-test.1" }, version), /empty tag/);
  assert.throws(() => releaseBuildPlan({ ...manual, GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.4.30", RELEASE_TEST_VERSION: "0.4.31-test.1" }, version), /empty tag/);
  assert.throws(() => releaseBuildPlan({ ...env, INPUT_RELEASE_TAG: "v0.4.29" }, version), /must match/);
});

test("only a manual tagged release can select a candidate producer", () => {
  const reuse = { ...manual, INPUT_RELEASE_TAG: `v${version}`, INPUT_CANDIDATE_RUN: "123" };
  assert.equal(releaseBuildPlan(reuse, version).candidate_run, "123");
  assert.throws(() => releaseBuildPlan({ ...reuse, INPUT_RELEASE_TAG: "" }, version), /requires a release tag/);
  assert.throws(() => releaseBuildPlan({ ...reuse, INPUT_CANDIDATE_RUN: "../123" }, version), /positive run ID/);
  assert.equal(releaseBuildPlan({ ...reuse, GITHUB_EVENT_NAME: "push", GITHUB_REF_TYPE: "tag",
    GITHUB_REF_NAME: `v${version}` }, version).candidate_run, "");
});

test("test versions reject malformed SemVer and command/env-file injection", () => {
  for (const valid of ["0.4.31", "0.4.31-permission.1", "1.2.3-0.alpha+build.01"]) validateTestVersion(valid, "");
  for (const invalid of ["01.2.3", "1.2", "v1.2.3", "1.2.3-test.01", "1.2.3-", "1.2.3\nTAG=v1.2.3", "$(id)", "`id`", "1.2.3-" + "a".repeat(100)]) {
    assert.throws(() => releaseBuildPlan({ ...manual, RELEASE_TEST_VERSION: invalid }, version), /valid SemVer/);
  }
  assert.throws(() => releaseBuildPlan({ ...manual, INPUT_PLATFORMS: "linux" }, version), /Unsupported/);
  assert.throws(() => releaseBuildPlan({ ...manual, INPUT_MACOS_ARCH: "all" }, version), /Unsupported/);
});
