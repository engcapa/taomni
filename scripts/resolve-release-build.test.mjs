import { strict as assert } from "node:assert";
import { test } from "node:test";
import { releaseBuildPlan, validateTestVersion } from "./resolve-release-build.mjs";

const version = "0.4.30";
const manual = { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF_TYPE: "branch" };

test("the default manual build collects all platforms without publishing", () => {
  assert.deepEqual(releaseBuildPlan(manual, version), {
    version, tag: "", test_version: "", build_desktop: "true", macos_aarch64: "true", macos_x86_64: "true",
  });
});

test("Intel-only upgrade tests resolve distinct versions without enabling releases", () => {
  for (const testVersion of ["0.4.31-permission.1", "0.4.31-permission.2"]) {
    const plan = releaseBuildPlan({ ...manual, INPUT_PLATFORMS: "macos", INPUT_MACOS_ARCH: "x86_64", RELEASE_TEST_VERSION: testVersion }, version);
    assert.deepEqual(plan, {
      version: testVersion, tag: "", test_version: testVersion, build_desktop: "false", macos_aarch64: "false", macos_x86_64: "true",
    });
  }
  const arm = releaseBuildPlan({ ...manual, INPUT_MACOS_ARCH: "aarch64" }, version);
  assert.equal(arm.macos_aarch64, "true");
  assert.equal(arm.macos_x86_64, "false");
});

test("tag pushes and published releases keep the full build, ignoring manual inputs", () => {
  for (const event of [
    { GITHUB_EVENT_NAME: "push", GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.4.30" },
    { GITHUB_EVENT_NAME: "release", RELEASE_EVENT_TAG: "v0.4.30" },
  ]) {
    const plan = releaseBuildPlan({ ...event, INPUT_PLATFORMS: "macos", INPUT_MACOS_ARCH: "x86_64", RELEASE_TEST_VERSION: "0.4.31-test.1" }, version);
    assert.equal(plan.tag, "v0.4.30");
    assert.equal(plan.version, version);
    for (const key of ["build_desktop", "macos_aarch64", "macos_x86_64"]) assert.equal(plan[key], "true");
  }
});

test("manual releases forbid partial builds and test versions before any bundles are built", () => {
  const env = { ...manual, INPUT_RELEASE_TAG: "v0.4.30" };
  assert.equal(releaseBuildPlan(env, version).tag, "v0.4.30");
  assert.throws(() => releaseBuildPlan({ ...env, INPUT_PLATFORMS: "macos" }, version), /every platform/);
  assert.throws(() => releaseBuildPlan({ ...env, INPUT_MACOS_ARCH: "x86_64" }, version), /both macOS/);
  assert.throws(() => releaseBuildPlan({ ...env, RELEASE_TEST_VERSION: "0.4.31-test.1" }, version), /empty tag/);
  assert.throws(() => releaseBuildPlan({ ...manual, GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.4.30", RELEASE_TEST_VERSION: "0.4.31-test.1" }, version), /empty tag/);
  assert.throws(() => releaseBuildPlan({ ...env, INPUT_RELEASE_TAG: "v0.4.29" }, version), /must match/);
});

test("test versions reject malformed SemVer and command/env-file injection", () => {
  for (const valid of ["0.4.31", "0.4.31-permission.1", "1.2.3-0.alpha+build.01"]) validateTestVersion(valid, "");
  for (const invalid of ["01.2.3", "1.2", "v1.2.3", "1.2.3-test.01", "1.2.3-", "1.2.3\nTAG=v1.2.3", "$(id)", "`id`", "1.2.3-" + "a".repeat(100)]) {
    assert.throws(() => releaseBuildPlan({ ...manual, RELEASE_TEST_VERSION: invalid }, version), /valid SemVer/);
  }
  assert.throws(() => releaseBuildPlan({ ...manual, INPUT_PLATFORMS: "linux" }, version), /Unsupported/);
  assert.throws(() => releaseBuildPlan({ ...manual, INPUT_MACOS_ARCH: "all" }, version), /Unsupported/);
});
