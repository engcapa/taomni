import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { publishedModuleCatalogTag } from "./stage-published-module-catalog.mjs";

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
  const macosRunner = manual && !tag ? env.INPUT_MACOS_RUNNER || "macos-15" : "macos-15";
  const testVersion = manual ? env.RELEASE_TEST_VERSION || "" : "";
  const candidateRun = manual ? env.INPUT_CANDIDATE_RUN || "" : "";
  if (candidateRun && !/^[1-9]\d*$/.test(candidateRun)) {
    throw new Error("candidate_run requires a positive run ID.");
  }
  const candidateSource = manual ? env.INPUT_CANDIDATE_SOURCE || "" : "";
  if (candidateSource && (!candidateRun || !/^[a-f0-9]{40}$/.test(candidateSource))) {
    throw new Error("candidate_source requires a candidate_run and a full lowercase commit SHA.");
  }
  if (candidateRun && (testVersion || env.INPUT_MACOS_STATIC_KRB5 === "true" || platforms !== "all" || arch !== "both")) {
    throw new Error("Candidate promotion requires the release version and all production targets.");
  }
  const moduleRehearsalRun = manual ? env.INPUT_MODULE_REHEARSAL_BASELINE_RUN?.trim() || "" : "";
  const moduleInput = manual ? env.INPUT_RELEASE_MODULES?.trim() : "";
  const modules = moduleInput ? moduleInput.split(",").map((slug) => slug.trim()) : [];
  if (modules.some((slug) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug))
    || new Set(modules).size !== modules.length) {
    throw new Error("modules must be a comma-separated list of unique module slugs.");
  }
  if (moduleRehearsalRun) {
    if (!/^[1-9]\d*$/.test(moduleRehearsalRun)) {
      throw new Error("module_rehearsal_baseline_run must be a positive run ID.");
    }
    if (tag || candidateRun) {
      throw new Error("module_rehearsal_baseline_run is read-only and requires an empty tag and candidate_run.");
    }
    if (env.INPUT_MACOS_STATIC_KRB5 === "true") {
      throw new Error("module_rehearsal_baseline_run cannot be combined with macos_static_krb5.");
    }
    if (modules.length !== 1) {
      throw new Error("module_rehearsal_baseline_run requires exactly one module slug in modules.");
    }
  }
  if (!["all", "macos", "windows"].includes(platforms) || !["both", "aarch64", "x86_64"].includes(arch)) {
    throw new Error("Unsupported build platform or macOS architecture.");
  }
  if (!["macos-15", "macos-26"].includes(macosRunner)) {
    throw new Error("Unsupported macOS build runner.");
  }
  validateTestVersion(testVersion, tag);
  if (tag && (platforms !== "all" || arch !== "both")) {
    throw new Error("Tagged releases require every platform and both macOS architectures.");
  }
  const macosArchitectures = moduleRehearsalRun ? [] : ["aarch64", "x86_64"].filter(
    (target) => platforms !== "windows" && (arch === "both" || arch === target),
  );
  if (manual && env.INPUT_MACOS_STATIC_KRB5 === "true" && (tag || !macosArchitectures.includes("aarch64"))) {
    throw new Error("Static Kerberos requires an artifact-only build that includes macOS ARM64.");
  }
  const desktopPlatforms = [];
  // Keep the Linux bundle on the glibc 2.35 baseline.
  if (!moduleRehearsalRun && platforms === "all") desktopPlatforms.push("ubuntu-22.04");
  if (!moduleRehearsalRun && platforms !== "macos") desktopPlatforms.push("windows-latest");
  return {
    version: testVersion || packageVersion,
    tag: tag || "",
    test_version: testVersion,
    build_desktop: String(desktopPlatforms.length > 0),
    desktop_platforms: JSON.stringify(desktopPlatforms),
    macos_architectures: JSON.stringify(macosArchitectures),
    macos_runner: macosRunner,
    modules: JSON.stringify(modules),
    candidate_run: candidateRun,
    module_rehearsal_baseline_run: moduleRehearsalRun,
  };
}

function firstReleaseSlugs() {
  const roster = JSON.parse(readFileSync(new URL("../src-tauri/plugins/legacy-upgrade.json", import.meta.url), "utf8"));
  return roster.map((id) => id.replace(/^taomni-plugin-/, "")).sort();
}

export function rehearsesFirstUpgrade(plan) {
  return !plan.tag && !plan.candidate_run && JSON.stringify(JSON.parse(plan.modules).sort()) === JSON.stringify(firstReleaseSlugs());
}

export function selectPublicationModules(plan, lookup = publishedModuleCatalogTag) {
  if ((!plan.tag && !plan.candidate_run) || lookup()) return plan;
  const slugs = firstReleaseSlugs();
  const requested = JSON.parse(plan.modules);
  if (requested.length && JSON.stringify(requested.sort()) !== JSON.stringify(slugs)) {
    throw new Error(`The first core release must build all legacy-upgrade modules: ${slugs.join(", ")}`);
  }
  return { ...plan, modules: JSON.stringify(slugs) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
    const plan = selectPublicationModules(releaseBuildPlan(process.env, packageVersion));
    if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(plan).map(([name, value]) => `${name}=${value}\n`).join(""));
    appendFileSync(process.env.GITHUB_OUTPUT, `rehearse_first_upgrade=${rehearsesFirstUpgrade(plan)}\n`);
    console.log(`Build ${plan.version}; ${plan.tag ? `release ${plan.tag}` : "workflow artifacts only"}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
