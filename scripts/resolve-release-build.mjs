import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function validateTestVersion(version, tag) {
  if (!version) return;
  if (tag) throw new Error("test_version is only allowed for artifact-only builds with an empty tag.");
  const number = "(?:0|[1-9][0-9]*)";
  const semver = new RegExp(`^${number}\\.${number}\\.${number}(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
  const match = version.length <= 100 && version.match(semver);
  if (!match || match[0] !== version || match[1]?.split(".").some((part) => /^[0-9]+$/.test(part) && part.length > 1 && part.startsWith("0"))) {
    throw new Error("test_version must be a valid SemVer of at most 100 characters.");
  }
}

export function releaseBuildPlan(env, packageVersion) {
  const manual = env.GITHUB_EVENT_NAME === "workflow_dispatch";
  const tag = env.GITHUB_EVENT_NAME === "release" ? env.RELEASE_EVENT_TAG
    : env.GITHUB_REF_TYPE === "tag" ? env.GITHUB_REF_NAME
      : manual ? env.INPUT_RELEASE_TAG ?? "" : "";
  if (tag && tag !== `v${packageVersion}`) {
    throw new Error(`Release tag '${tag}' must match package.json version 'v${packageVersion}'.`);
  }
  const platforms = manual ? env.INPUT_PLATFORMS || "all" : "all";
  const arch = manual ? env.INPUT_MACOS_ARCH || "both" : "both";
  const testVersion = manual ? env.RELEASE_TEST_VERSION || "" : "";
  if (!["all", "macos"].includes(platforms) || !["both", "aarch64", "x86_64"].includes(arch)) {
    throw new Error("Unsupported build platform or macOS architecture.");
  }
  validateTestVersion(testVersion, tag);
  if (tag && (platforms !== "all" || arch !== "both")) {
    throw new Error("Tagged releases require every platform and both macOS architectures.");
  }
  return {
    version: testVersion || packageVersion,
    tag: tag || "",
    test_version: testVersion,
    build_desktop: String(platforms === "all"),
    macos_aarch64: String(arch !== "x86_64"),
    macos_x86_64: String(arch !== "aarch64"),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
    const plan = releaseBuildPlan(process.env, packageVersion);
    if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(plan).map(([name, value]) => `${name}=${value}\n`).join(""));
    console.log(`Build ${plan.version}; ${plan.tag ? `release ${plan.tag}` : "workflow artifacts only"}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
