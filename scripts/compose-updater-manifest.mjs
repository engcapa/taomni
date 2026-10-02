import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const RELEASE_PLATFORMS = ["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "windows-x86_64"];

function filesIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Artifact must not be a symlink: ${path}`);
    return entry.isDirectory() ? filesIn(path) : [path];
  });
}

function artifactPlatform(name, version) {
  const prefix = `taomni-${version}-`;
  if (!name.startsWith(prefix)) throw new Error(`Unknown artifact or wrong version: ${name}`);
  const platform = name.slice(prefix.length);
  if (platform === "macos-aarch64") return { os: "darwin", arch: "aarch64" };
  if (platform === "macos-x86_64") return { os: "darwin", arch: "x86_64" };
  if (platform === "ubuntu-22.04") return { os: "linux", arch: "x86_64" };
  if (platform === "windows-latest") return { os: "windows", arch: "x86_64" };
  throw new Error(`Unknown artifact platform: ${name}`);
}

function bundleType(name) {
  if (name.endsWith(".app.tar.gz")) return "app";
  if (/\.AppImage(?:\.tar\.gz)?$/.test(name)) return "appimage";
  if (name.endsWith(".deb")) return "deb";
  if (name.endsWith(".rpm")) return "rpm";
  if (/-setup\.(?:exe|nsis\.zip)$/.test(name)) return "nsis";
  if (/\.msi(?:\.zip)?$/.test(name)) return "msi";
  return null;
}

/** Stage signed updater assets before any upload. Renaming never alters signed bytes. */
export function composeUpdaterManifest({
  artifactsDir, outputDir, tag, repository, notes = "", pubDate = new Date().toISOString(),
  requiredPlatforms = RELEASE_PLATFORMS,
}) {
  if (!/^v\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/.test(tag)) throw new Error("Invalid release tag");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid GitHub repository");
  const version = tag.slice(1);
  const baseUrl = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}`;
  const entries = new Map();
  const assets = [];
  const names = new Set();
  const register = (key, entry) => {
    if (entries.has(key)) throw new Error(`Duplicate updater target: ${key}`);
    entries.set(key, entry);
  };

  for (const artifact of readdirSync(artifactsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!artifact.isDirectory()) throw new Error(`Expected artifact directory: ${artifact.name}`);
    const { os, arch } = artifactPlatform(artifact.name, version);
    const files = filesIn(join(artifactsDir, artifact.name));
    for (const bundle of files.filter((path) => bundleType(basename(path)))) {
      if (!existsSync(`${bundle}.sig`)) throw new Error(`Missing signature: ${bundle}.sig`);
    }
    for (const sig of files.filter((path) => path.endsWith(".sig"))) {
      const bundle = sig.slice(0, -4);
      if (!existsSync(bundle) || !statSync(bundle).isFile()) throw new Error(`Missing bundle for signature: ${sig}`);
      const type = bundleType(basename(bundle));
      if (!type) throw new Error(`Unsupported signed updater asset: ${bundle}`);
      if ((type === "app" && os !== "darwin") || (["appimage", "deb", "rpm"].includes(type) && os !== "linux") || (["nsis", "msi"].includes(type) && os !== "windows")) {
        throw new Error(`Bundle type does not match artifact platform: ${bundle}`);
      }
      const signature = readFileSync(sig, "utf8").trim();
      if (!signature) throw new Error(`Empty signature: ${sig}`);
      const asset = type === "app" ? `Taomni_${version}_${arch}.app.tar.gz` : basename(bundle);
      if (names.has(asset)) throw new Error(`Conflicting updater asset filename: ${asset}`);
      names.add(asset);
      const entry = { signature, url: `${baseUrl}/${encodeURIComponent(asset)}` };
      register(`${os}-${arch}-${type}`, entry);
      if (type === "app" || type === "appimage") register(`${os}-${arch}`, entry);
      assets.push({ bundle, sig, name: asset });
    }
  }
  // Keep installer-specific keys, but NSIS is always the Windows default.
  const windows = entries.get("windows-x86_64-nsis") ?? entries.get("windows-x86_64-msi");
  if (windows) register("windows-x86_64", windows);
  for (const key of requiredPlatforms) {
    if (!entries.has(key)) throw new Error(`missing required platform: ${key}`);
  }
  if (assets.length === 0) throw new Error("No signed updater assets found");
  if (existsSync(outputDir) && (!statSync(outputDir).isDirectory() || readdirSync(outputDir).length)) {
    throw new Error("Updater staging directory must be empty");
  }
  const manifest = {
    version, notes: notes || `Desktop bundles for Taomni ${tag}.`, pub_date: pubDate,
    platforms: Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b))),
  };
  mkdirSync(outputDir, { recursive: true });
  for (const asset of assets) {
    copyFileSync(asset.bundle, join(outputDir, asset.name));
    copyFileSync(asset.sig, join(outputDir, `${asset.name}.sig`));
  }
  writeFileSync(join(outputDir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, assets: assets.map((asset) => asset.name) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [artifactsDir, outputDir] = process.argv.slice(2);
  if (!artifactsDir || !outputDir) throw new Error("Usage: node scripts/compose-updater-manifest.mjs <artifacts-dir> <staging-dir>");
  const result = composeUpdaterManifest({
    artifactsDir, outputDir, tag: process.env.TAG, repository: process.env.GITHUB_REPOSITORY,
    notes: process.env.RELEASE_NOTES, pubDate: process.env.PUB_DATE,
  });
  console.log(`Staged ${result.assets.length} signed updater assets for ${Object.keys(result.manifest.platforms).length} platform keys`);
}
