import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MODULE_PLATFORMS = [
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-x86_64",
  "windows-x86_64",
];

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PLATFORM_SET = new Set(MODULE_PLATFORMS);
const MOBILE_ID = "taomni-plugin-mobile";
const MOBILE_RELEASE_EXCEPTION = {
  name: "Mobile",
  placement: "core",
  notes: "Mobile remains in the core application, including mobile connections, desktop control, Feishu integration, and headless mode.",
};

export function appendModuleReleaseNotes(notes, catalog) {
  const exception = catalog?.releaseExceptions?.[MOBILE_ID];
  if (exception?.placement !== "core" || !exception.notes || notes.includes(exception.notes)) {
    return notes;
  }
  return [notes.trimEnd(), exception.notes].filter(Boolean).join("\n\n");
}

function filesIn(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Artifact must not be a symlink: ${path}`);
      return entry.isDirectory() ? filesIn(path) : [path];
    });
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function moduleManifestFor(packagePath) {
  const candidates = [
    join(dirname(packagePath), "module.json"),
    join(dirname(packagePath), basename(packagePath, ".taomni-plugin"), "module.json"),
    join(dirname(dirname(packagePath)), "module.json"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return readJson(candidate, "module.json");
  }

  // Builders normally upload module.json next to the package. Supporting a
  // package-only artifact keeps the generator useful for manually assembled
  // releases and verifies the same metadata that is shipped in the archive.
  try {
    const text = execFileSync("unzip", ["-p", packagePath, "module.json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (text) return JSON.parse(text);
  } catch {
    // A non-zip fixture or a runner without unzip is reported by the explicit
    // error below; it must never silently produce an incomplete manifest.
  }
  throw new Error(`Missing module.json for plugin package: ${packagePath}`);
}

function validateModuleManifest(input, coreApiVersion) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("module.json must be an object");
  const id = input.id;
  const slug = input.slug;
  const version = input.version;
  if (typeof slug !== "string" || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) throw new Error("module.json slug is invalid");
  if (id !== `taomni-plugin-${slug}`) throw new Error(`module.json id must equal taomni-plugin-${slug}`);
  if (typeof version !== "string" || !VERSION.test(version)) throw new Error(`module.json version is invalid for ${slug}`);
  if (input.coreApiVersion !== coreApiVersion) throw new Error(`module ${slug} requires coreApiVersion ${input.coreApiVersion ?? "<missing>"}, expected ${coreApiVersion}`);
  if (!Array.isArray(input.platforms) || input.platforms.length === 0 || input.platforms.some((platform) => !PLATFORM_SET.has(platform))) {
    throw new Error(`module ${slug} has invalid platforms`);
  }
  const kinds = ["remote-client", "local-server", "collaboration", "media", "auth", "ai-local", "mobile"];
  if (input.kind !== undefined && !kinds.includes(input.kind)) throw new Error(`module ${slug} has an invalid kind`);
  if (input.permissions !== undefined && (!Array.isArray(input.permissions) || input.permissions.some((permission) => typeof permission !== "string"))) {
    throw new Error(`module ${slug} has invalid permissions`);
  }
  if (input.description !== undefined && typeof input.description !== "string") {
    throw new Error(`module ${slug} has an invalid description`);
  }
  return { id, slug, version, name: typeof input.name === "string" ? input.name : slug, coreApiVersion, platforms: input.platforms,
    kind: input.kind, permissions: input.permissions?.slice().sort(), description: input.description?.trim(), status: input.status };
}

function packagePlatform(packagePath, manifest) {
  const name = basename(packagePath);
  const matches = MODULE_PLATFORMS.filter((platform) => {
    const escaped = platform.replaceAll("-", "\\-");
    return new RegExp(`(?:^|[-_])${escaped}(?:[-_.]|$)`).test(name) || packagePath.split(/[\\/]/).includes(platform);
  });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Ambiguous plugin package platform: ${packagePath}`);
  if (manifest.platforms.length === 1) return manifest.platforms[0];
  throw new Error(`Plugin package must include one platform in its name or path: ${packagePath}`);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readSignature(packagePath) {
  const path = `${packagePath}.minisig`;
  if (existsSync(path) && statSync(path).isFile()) {
    const signature = readFileSync(path, "utf8");
    if (!signature.trim()) throw new Error(`Empty plugin signature: ${path}`);
    return { path, signature };
  }
  throw new Error(`Missing plugin signature for ${packagePath} (.minisig)`);
}

function verifyChecksumSidecar(packagePath, digest) {
  const path = join(dirname(packagePath), "SHA256SUMS");
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const name = basename(packagePath);
  const line = lines.find((candidate) => candidate.endsWith(`  ${name}`) || candidate.endsWith(` *${name}`));
  if (!line) throw new Error(`SHA256SUMS does not contain ${name}`);
  const expected = line.split(/\s+/, 1)[0].toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected) || expected !== digest) throw new Error(`SHA256SUMS mismatch for ${packagePath}`);
}

/**
 * Build the independent plugin catalogue. Each package directory contains a
 * .taomni-plugin, its detached .minisig, and module.json. The core updater's
 * latest.json is intentionally not touched by this function.
 */
export function composeModulesManifest({
  artifactsDir,
  outputDir,
  tag,
  repository,
  coreApiVersion = "1",
  sequence = 1,
  updatedAt = new Date().toISOString(),
  requireManifestSignature = false,
  manifestSignaturePath,
  legacyUpgrade,
}) {
  if (!/^v\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/.test(tag)) throw new Error("Invalid release tag");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid GitHub repository");
  if (!/^\d+$/.test(String(coreApiVersion))) throw new Error("coreApiVersion must be a numeric string");
  if (!Number.isSafeInteger(Number(sequence)) || Number(sequence) < 1) throw new Error("sequence must be a positive integer");
  if (!existsSync(artifactsDir) || !statSync(artifactsDir).isDirectory()) throw new Error(`Artifact directory does not exist: ${artifactsDir}`);
  if (existsSync(outputDir) && (!statSync(outputDir).isDirectory() || readdirSync(outputDir).length)) throw new Error("Module staging directory must be empty");

  const packages = filesIn(artifactsDir).filter((path) => path.endsWith(".taomni-plugin"));
  if (packages.length === 0) throw new Error("No .taomni-plugin packages found");
  const baseUrl = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}`;
  const plugins = new Map();
  const manifests = new Map();
  const assets = [];
  const names = new Set();

  for (const packagePath of packages) {
    const rawManifest = moduleManifestFor(packagePath);
    const manifest = validateModuleManifest(rawManifest, String(coreApiVersion));
    if (manifest.version !== rawManifest.version) throw new Error(`Invalid version for ${manifest.slug}`);
    const platform = packagePlatform(packagePath, manifest);
    if (!manifest.platforms.includes(platform)) throw new Error(`Plugin ${manifest.slug} does not declare package platform ${platform}`);
    const signature = readSignature(packagePath);
    const digest = sha256(packagePath);
    verifyChecksumSidecar(packagePath, digest);
    const assetName = basename(packagePath);
    if (names.has(assetName)) throw new Error(`Conflicting plugin release asset filename: ${assetName}`);
    names.add(assetName);
    const published = manifests.get(manifest.id);
    if (published && (published.status !== manifest.status || published.description !== manifest.description ||
        [...published.platforms].sort().join() !== [...manifest.platforms].sort().join())) {
      throw new Error(`Plugin ${manifest.slug} has inconsistent metadata across platforms`);
    }
    manifests.set(manifest.id, manifest);
    const plugin = plugins.get(manifest.id) ?? {
      id: manifest.id,
      slug: manifest.slug,
      name: manifest.name,
      version: manifest.version,
      coreApiVersion: manifest.coreApiVersion,
      ...(manifest.kind !== undefined ? { kind: manifest.kind } : {}),
      ...(manifest.permissions !== undefined ? { permissions: manifest.permissions } : {}),
      ...(manifest.description ? { description: manifest.description } : {}),
      platforms: {},
    };
    if (plugin.version !== manifest.version) throw new Error(`Plugin ${manifest.slug} has multiple versions in one release`);
    if (plugin.name !== manifest.name || plugin.kind !== manifest.kind || JSON.stringify(plugin.permissions) !== JSON.stringify(manifest.permissions)) {
      throw new Error(`Plugin ${manifest.slug} has inconsistent metadata across platforms`);
    }
    if (plugin.platforms[platform]) throw new Error(`Duplicate plugin target: ${manifest.id}/${platform}`);
    plugin.platforms[platform] = {
      url: `${baseUrl}/${encodeURIComponent(assetName)}`,
      signature: signature.signature.trim(),
      sha256: digest,
      size: statSync(packagePath).size,
    };
    plugins.set(manifest.id, plugin);
    assets.push({ packagePath, signaturePath: signature.path, assetName });
  }

  if (legacyUpgrade !== undefined) {
    if (!Array.isArray(legacyUpgrade) || new Set(legacyUpgrade).size !== legacyUpgrade.length) {
      throw new Error("legacyUpgrade must contain unique module IDs");
    }
    for (const id of legacyUpgrade) {
      const module = manifests.get(id);
      if (id === "taomni-plugin-lanchat" || module?.status !== "stable" || !module.description) {
        throw new Error(`legacyUpgrade requires a stable module with a description: ${id}`);
      }
      if (module.platforms.some((platform) => !plugins.get(id).platforms[platform])) {
        throw new Error(`legacyUpgrade requires all declared platform assets for ${id}`);
      }
    }
    for (const module of manifests.values()) {
      if (module.status === "stable" && !module.description) {
        throw new Error(`Stable module ${module.id} needs a description for the module store`);
      }
    }
  }
  const manifest = {
    coreApiVersion: String(coreApiVersion),
    sequence: Number(sequence),
    updatedAt,
    ...(legacyUpgrade !== undefined ? { legacyUpgrade: [...legacyUpgrade].sort() } : {}),
    ...(legacyUpgrade?.length && !plugins.has(MOBILE_ID) ? {
      releaseExceptions: { [MOBILE_ID]: MOBILE_RELEASE_EXCEPTION },
    } : {}),
    plugins: Object.fromEntries([...plugins].sort(([a], [b]) => a.localeCompare(b))),
  };
  mkdirSync(outputDir, { recursive: true });
  for (const asset of assets) {
    copyFileSync(asset.packagePath, join(outputDir, asset.assetName));
    copyFileSync(asset.signaturePath, join(outputDir, `${asset.assetName}.minisig`));
  }
  writeFileSync(join(outputDir, "modules.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const signatureSource = manifestSignaturePath ?? join(artifactsDir, "modules.json.minisig");
  if (existsSync(signatureSource)) copyFileSync(signatureSource, join(outputDir, "modules.json.minisig"));
  else if (requireManifestSignature) throw new Error("Missing detached modules.json.minisig");
  return { manifest, assets: assets.map((asset) => asset.assetName), signedManifest: existsSync(join(outputDir, "modules.json.minisig")) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [artifactsDir, outputDir, mode, ...extra] = process.argv.slice(2);
  if (!artifactsDir || !outputDir || (mode && mode !== "--delta") || extra.length) {
    throw new Error("Usage: node scripts/compose-modules-manifest.mjs <artifacts-dir> <staging-dir> [--delta]");
  }
  const published = process.env.MODULES_PUBLISHED_CATALOG
    ? readJson(process.env.MODULES_PUBLISHED_CATALOG, "published modules.json") : null;
  if (published && (!Number.isSafeInteger(published.sequence) || published.sequence < 1)) {
    throw new Error("Published module catalog has an invalid sequence");
  }
  const requestedSequence = process.env.MODULE_SEQUENCE ?? process.env.GITHUB_RUN_NUMBER ?? "1";
  const configuredRoster = process.env.MODULES_LEGACY_UPGRADE_IDS?.split(",").map((id) => id.trim()).filter(Boolean);
  const result = composeModulesManifest({
    artifactsDir,
    outputDir,
    tag: process.env.TAG,
    repository: process.env.GITHUB_REPOSITORY ?? process.env.GH_REPO,
    coreApiVersion: process.env.MODULE_CORE_API_VERSION ?? "1",
    sequence: published ? Math.max(Number(requestedSequence), published.sequence + 1) : requestedSequence,
    updatedAt: process.env.MODULE_UPDATED_AT ?? new Date().toISOString(),
    requireManifestSignature: process.env.MODULES_REQUIRE_SIGNATURE === "1",
    manifestSignaturePath: process.env.MODULES_MANIFEST_SIGNATURE,
    legacyUpgrade: mode === "--delta" ? undefined : (configuredRoster?.length ? configuredRoster : published?.legacyUpgrade),
  });
  console.log(`Staged ${result.assets.length} plugin packages for ${Object.keys(result.manifest.plugins).length} plugins${result.signedManifest ? " with signed modules.json" : ""}`);
}
