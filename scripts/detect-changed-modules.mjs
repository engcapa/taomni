import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compareSemver, listStableModules } from "./release-version-utils.mjs";

const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;
const POSITIVE_INT = /^[1-9]\d*$/;

export function selectModulesForRelease({
  repoRoot,
  catalog,
  mode = "auto-changed",
  manualModules = "",
  tag = "",
  coreTag,
  runNumber = "1",
}) {
  if (!coreTag || !RELEASE_TAG.test(coreTag)) {
    throw new Error(`coreTag must be a semantic version prefixed with v (got '${String(coreTag)}').`);
  }
  if (!["auto-changed", "manual"].includes(mode)) {
    throw new Error(`Unsupported batch release mode '${mode}'. Expected 'auto-changed' or 'manual'.`);
  }
  const stableModules = listStableModules(repoRoot);
  const bySlug = new Map(stableModules.map((mod) => [mod.slug, mod]));
  const publishedPlugins = catalog?.plugins && typeof catalog.plugins === "object" ? catalog.plugins : {};

  let selected = [];
  if (mode === "auto-changed") {
    for (const mod of stableModules) {
      const published = publishedPlugins[mod.id]?.version ?? null;
      if (published) {
        const cmp = compareSemver(mod.version, published);
        if (cmp < 0) {
          throw new Error(
            `Module '${mod.slug}' local version (${mod.version}) is behind published catalog version (${published}); check out current main first.`,
          );
        }
        if (cmp > 0) selected.push({ ...mod, publishedVersion: published, reason: "updated" });
      } else {
        selected.push({ ...mod, publishedVersion: null, reason: "new" });
      }
    }
    if (selected.length === 0) {
      throw new Error(
        `No stable modules have a newer version than published catalog (${coreTag}). Bump module version(s) first or switch mode to 'manual'.`,
      );
    }
  } else {
    const rawText = typeof manualModules === "string" ? manualModules.trim() : "";
    if (!rawText) {
      throw new Error("mode='manual' requires a comma-separated list of module slugs in 'modules'.");
    }
    const seen = new Set();
    for (const token of rawText.split(",")) {
      const slug = token.trim();
      if (!slug) throw new Error("modules list contains an empty item.");
      if (seen.has(slug)) throw new Error(`Duplicate module slug in modules list: '${slug}'.`);
      seen.add(slug);
      const mod = bySlug.get(slug);
      if (!mod) {
        throw new Error(`Unknown or non-stable module slug '${slug}'. Stable modules: ${stableModules.map((m) => m.slug).join(", ")}`);
      }
      const published = publishedPlugins[mod.id]?.version ?? null;
      if (published && compareSemver(mod.version, published) <= 0) {
        throw new Error(
          `Module '${mod.slug}' version (${mod.version}) must be greater than published catalog version (${published}). Bump its version first.`,
        );
      }
      selected.push({ ...mod, publishedVersion: published, reason: published ? "updated" : "new" });
    }
    selected.sort((left, right) => left.slug.localeCompare(right.slug));
  }

  const trimmedTag = typeof tag === "string" ? tag.trim() : "";
  let resolvedTag = trimmedTag;
  if (!resolvedTag) {
    if (selected.length === 1) {
      resolvedTag = `v${selected[0].version}-${selected[0].slug}`;
    } else {
      const num = String(runNumber).trim();
      if (!POSITIVE_INT.test(num)) {
        throw new Error(`runNumber must be a positive integer when auto-generating a batch release tag (got '${num}').`);
      }
      resolvedTag = `${coreTag}-modules.${num}`;
    }
  }
  if (!RELEASE_TAG.test(resolvedTag) || resolvedTag === coreTag) {
    throw new Error(`Release tag '${resolvedTag}' must be a SemVer tag prefixed with v and distinct from core tag '${coreTag}'.`);
  }

  const expectedPackages = selected.reduce((sum, mod) => sum + mod.platforms.length, 0);
  const rows = selected.map(
    (mod) => `| \`${mod.slug}\` | \`${mod.publishedVersion ?? "new"}\` | \`${mod.version}\` | ${mod.platforms.length} |`,
  );
  const summaryMarkdown = [
    `### Planned Module Batch Release (\`${resolvedTag}\`)`,
    "",
    `- Mode: \`${mode}\``,
    `- Core baseline release: \`${coreTag}\``,
    `- Modules (${selected.length}): ${selected.map((mod) => `\`${mod.slug}\``).join(", ")}`,
    `- Expected signed archives: ${expectedPackages}`,
    "",
    "| Module | Published | Next | Platforms |",
    "| :--- | :--- | :--- | :---: |",
    ...rows,
  ].join("\n");

  return {
    modules: selected.map((mod) => mod.slug),
    details: selected,
    expectedPackages,
    tag: resolvedTag,
    summaryMarkdown,
  };
}

function parseCliArgs(argv) {
  const opts = { repoRoot: process.cwd(), catalogPath: "", mode: "auto-changed", manualModules: "", tag: "", coreTag: "", runNumber: "1" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo-root") opts.repoRoot = resolve(argv[++i]);
    else if (arg === "--catalog") opts.catalogPath = resolve(argv[++i]);
    else if (arg === "--mode") opts.mode = argv[++i] ?? "auto-changed";
    else if (arg === "--modules") opts.manualModules = argv[++i] ?? "";
    else if (arg === "--tag") opts.tag = argv[++i] ?? "";
    else if (arg === "--core-tag") opts.coreTag = argv[++i] ?? "";
    else if (arg === "--run-number") opts.runNumber = argv[++i] ?? "1";
    else if (arg === "--github-output") opts.githubOutput = argv[++i] ?? "";
    else if (arg === "--summary-file") opts.summaryFile = argv[++i] ?? "";
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const opts = parseCliArgs(process.argv.slice(2));
  if (!opts.catalogPath) throw new Error("--catalog is required");
  const catalog = JSON.parse(readFileSync(opts.catalogPath, "utf8"));
  const result = selectModulesForRelease({
    repoRoot: opts.repoRoot,
    catalog,
    mode: opts.mode,
    manualModules: opts.manualModules,
    tag: opts.tag,
    coreTag: opts.coreTag,
    runNumber: opts.runNumber,
  });
  if (opts.githubOutput) {
    appendFileSync(
      opts.githubOutput,
      `modules=${JSON.stringify(result.modules)}\nexpected_packages=${result.expectedPackages}\ntag=${result.tag}\n`,
      "utf8",
    );
  }
  if (opts.summaryFile) {
    appendFileSync(opts.summaryFile, `${result.summaryMarkdown}\n`, "utf8");
  }
  console.log(`Selected ${result.modules.length} module(s) (${result.expectedPackages} package targets) for ${result.tag}: ${result.modules.join(", ")}`);
}
