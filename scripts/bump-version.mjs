import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  bumpSemver,
  compareSemver,
  listStableModules,
  parseSemver,
  readCargoPackageMeta,
  replaceCargoPackageVersion,
  replaceJsonTopLevelVersion,
} from "./release-version-utils.mjs";

const BUMP_KINDS = new Set(["patch", "minor", "major"]);

function readCoreMeta(repoRoot) {
  const packageJsonPath = join(repoRoot, "package.json");
  const cargoPath = join(repoRoot, "src-tauri", "Cargo.toml");
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const cargo = readCargoPackageMeta(cargoPath);
  if (pkg.version !== cargo.version) {
    throw new Error(`Core version mismatch: package.json=${pkg.version}, src-tauri/Cargo.toml=${cargo.version}`);
  }
  return {
    slug: "core",
    version: pkg.version,
    packageName: cargo.name,
    jsonPath: packageJsonPath,
    cargoPath,
  };
}

function resolveNextVersion(currentVersion, spec, explicitVersion, targetLabel) {
  if (BUMP_KINDS.has(spec)) return bumpSemver(currentVersion, spec);
  const raw = spec === "explicit" ? explicitVersion : spec;
  if (!raw || !String(raw).trim()) {
    throw new Error(`Target '${targetLabel}' requires a concrete version when bump='${spec}'.`);
  }
  const parsed = parseSemver(String(raw));
  if (compareSemver(parsed.raw, currentVersion) <= 0) {
    throw new Error(`New version '${parsed.raw}' for '${targetLabel}' must be greater than current version '${currentVersion}'.`);
  }
  return parsed.raw;
}

function formatPrMetadata(repoRoot, entries, today = new Date().toISOString().slice(0, 10)) {
  const coreEntry = entries.find((entry) => entry.target === "core");
  const moduleEntries = entries.filter((entry) => entry.target !== "core");
  const datePart = today.replace(/-/g, "");
  let branch;
  let title;
  if (entries.length === 1 && coreEntry) {
    branch = `chore/bump-core-${coreEntry.nextVersion}`;
    title = `chore(release): bump core to ${coreEntry.nextVersion}`;
  } else if (entries.length === 1 && moduleEntries.length === 1) {
    const mod = moduleEntries[0];
    branch = `chore/bump-${mod.target}-${mod.nextVersion}`;
    title = `chore(modules): bump ${mod.target} to ${mod.nextVersion}`;
  } else if (!coreEntry) {
    branch = `chore/bump-modules-${datePart}`;
    title = `chore(modules): bump ${moduleEntries.map((m) => m.target).join(", ")}`;
  } else {
    branch = `chore/bump-release-${coreEntry.nextVersion}-modules`;
    title = `chore(release): bump core to ${coreEntry.nextVersion} and ${moduleEntries.length} module(s)`;
  }

  const rows = entries.map((entry) => {
    const files = entry.files.map((file) => `\`${relative(repoRoot, file).split("\\").join("/")}\``).join(", ");
    return `| \`${entry.target}\` | \`${entry.currentVersion}\` -> \`${entry.nextVersion}\` | \`${entry.packageName}\` | ${files} |`;
  });

  let releaseGuide;
  if (coreEntry && moduleEntries.length === 0) {
    releaseGuide = [
      `1. Review and merge this PR into \`main\`.`,
      `2. Run **Actions → Release Bundle** on \`main\` with \`tag\`: \`v${coreEntry.nextVersion}\`.`,
    ];
  } else if (coreEntry && moduleEntries.length > 0) {
    releaseGuide = [
      `1. Review and merge this PR into \`main\`.`,
      `2. Run **Actions → Release Bundle** on \`main\` with \`tag\`: \`v${coreEntry.nextVersion}\` and \`modules\`: \`${moduleEntries.map((m) => m.target).join(",")}\` (or release modules afterward with **Release Modules Batch** \`mode: auto-changed\`).`,
    ];
  } else if (moduleEntries.length === 1) {
    const mod = moduleEntries[0];
    releaseGuide = [
      `1. Review and merge this PR into \`main\`.`,
      `2. Run either **Actions → Release Modules Batch** (\`mode: auto-changed\`, \`tag\` blank) or **Actions → Release Module Catalog** (\`module\`: \`${mod.target}\`, \`tag\`: \`v${mod.nextVersion}-${mod.target}\`).`,
    ];
  } else {
    releaseGuide = [
      `1. Review and merge this PR into \`main\`.`,
      `2. Run **Actions → Release Modules Batch** on \`main\` with \`mode: auto-changed\` (leave \`tag\` blank to auto-detect and bundle all updated modules without concurrency conflicts).`,
    ];
  }

  const body = [
    "## Automated Version Bump",
    "",
    "| Target | Version | Cargo Package | Updated Files |",
    "| :--- | :--- | :--- | :--- |",
    ...rows,
    "| `Cargo.lock` | synced (`--locked` verified) | — | `src-tauri/Cargo.lock` |",
    "",
    "### Next Step After Merging",
    ...releaseGuide,
  ].join("\n");

  return { branch, title, body, summary: entries.map((e) => `${e.target}: ${e.currentVersion} -> ${e.nextVersion}`).join(", ") };
}

export function planVersionBumps({ repoRoot, target, bump = "patch", explicitVersion = "", extraBumps = "", today }) {
  const core = readCoreMeta(repoRoot);
  const stableModules = listStableModules(repoRoot);
  const bySlug = new Map(stableModules.map((mod) => [mod.slug, mod]));
  const requested = [];

  if (!target) throw new Error("Missing required input 'target'.");
  if (target !== "batch-custom") {
    requested.push({ target, spec: bump, explicitVersion });
  }
  const extraText = typeof extraBumps === "string" ? extraBumps.trim() : "";
  if (extraText) {
    for (const token of extraText.split(",")) {
      const part = token.trim();
      if (!part) throw new Error("extra_bumps contains an empty item.");
      const eq = part.indexOf("=");
      if (eq <= 0 || eq === part.length - 1) {
        throw new Error(`Invalid extra_bumps item '${part}'. Expected '<target>=<patch|minor|major|X.Y.Z>'.`);
      }
      requested.push({ target: part.slice(0, eq).trim(), spec: part.slice(eq + 1).trim(), explicitVersion: "" });
    }
  } else if (target === "batch-custom") {
    throw new Error("target='batch-custom' requires non-empty extra_bumps (for example 'servers=patch,vnc-server=patch').");
  }

  const seen = new Set();
  const entries = [];
  for (const item of requested) {
    if (seen.has(item.target)) throw new Error(`Duplicate version bump target: '${item.target}'.`);
    seen.add(item.target);
    if (item.target === "core") {
      const nextVersion = resolveNextVersion(core.version, item.spec, item.explicitVersion, "core");
      entries.push({
        target: "core",
        currentVersion: core.version,
        nextVersion,
        packageName: core.packageName,
        kind: "core",
        files: [core.jsonPath, core.cargoPath],
      });
      continue;
    }
    const mod = bySlug.get(item.target);
    if (!mod) {
      throw new Error(`Unknown or non-stable module target '${item.target}'. Stable modules: ${stableModules.map((m) => m.slug).join(", ")}`);
    }
    const nextVersion = resolveNextVersion(mod.version, item.spec, item.explicitVersion, mod.slug);
    entries.push({
      target: mod.slug,
      currentVersion: mod.version,
      nextVersion,
      packageName: mod.packageName,
      kind: "module",
      files: [mod.manifestPath, mod.cargoPath],
    });
  }
  const pr = formatPrMetadata(repoRoot, entries, today);
  return { entries, ...pr };
}

function defaultRunCargo(repoRoot, args) {
  execFileSync("cargo", args, { cwd: repoRoot, stdio: "inherit" });
}

export function applyVersionBumps({ repoRoot, plan, dryRun = false, skipCargo = false, runCargo = defaultRunCargo }) {
  const updates = [];
  for (const entry of plan.entries) {
    const [jsonPath, cargoPath] = entry.files;
    const jsonLabel = relative(repoRoot, jsonPath);
    const cargoLabel = relative(repoRoot, cargoPath);
    const nextJson = replaceJsonTopLevelVersion(readFileSync(jsonPath, "utf8"), entry.currentVersion, entry.nextVersion, jsonLabel);
    const nextCargo = replaceCargoPackageVersion(readFileSync(cargoPath, "utf8"), entry.currentVersion, entry.nextVersion, cargoLabel);
    updates.push({ path: jsonPath, content: nextJson }, { path: cargoPath, content: nextCargo });
  }
  if (dryRun) return updates;
  for (const file of updates) writeFileSync(file.path, file.content, "utf8");

  const lockPath = join(repoRoot, "src-tauri", "Cargo.lock");
  if (!skipCargo && existsSync(lockPath)) {
    const manifestPath = join(repoRoot, "src-tauri", "Cargo.toml");
    const packageArgs = plan.entries.flatMap((entry) => ["-p", entry.packageName]);
    runCargo(repoRoot, ["update", "--manifest-path", manifestPath, "--offline", ...packageArgs]);
    runCargo(repoRoot, ["metadata", "--manifest-path", manifestPath, "--locked", "--offline", "--format-version", "1"]);
  }
  return updates;
}

function parseCliArgs(argv) {
  const opts = { repoRoot: process.cwd(), target: "", bump: "patch", explicitVersion: "", extraBumps: "", dryRun: false, skipCargo: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--skip-cargo") opts.skipCargo = true;
    else if (arg === "--repo-root") opts.repoRoot = resolve(argv[++i]);
    else if (arg === "--target") opts.target = argv[++i] ?? "";
    else if (arg === "--bump") opts.bump = argv[++i] ?? "patch";
    else if (arg === "--explicit-version") opts.explicitVersion = argv[++i] ?? "";
    else if (arg === "--extra-bumps") opts.extraBumps = argv[++i] ?? "";
    else if (arg === "--github-output") opts.githubOutput = argv[++i] ?? "";
    else if (arg === "--pr-body") opts.prBody = argv[++i] ?? "";
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function appendMultilineOutput(file, key, value) {
  const delimiter = `EOF_${key}_${process.pid}`;
  appendFileSync(file, `${key}<<${delimiter}\n${value}\n${delimiter}\n`, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const opts = parseCliArgs(process.argv.slice(2));
  const plan = planVersionBumps(opts);
  applyVersionBumps({ repoRoot: opts.repoRoot, plan, dryRun: opts.dryRun, skipCargo: opts.skipCargo });
  if (opts.prBody) writeFileSync(opts.prBody, `${plan.body}\n`, "utf8");
  if (opts.githubOutput) {
    appendMultilineOutput(opts.githubOutput, "branch", plan.branch);
    appendMultilineOutput(opts.githubOutput, "title", plan.title);
    appendMultilineOutput(opts.githubOutput, "summary", plan.summary);
  }
  console.log(`${opts.dryRun ? "[dry-run] " : ""}${plan.title} (${plan.summary})`);
}
