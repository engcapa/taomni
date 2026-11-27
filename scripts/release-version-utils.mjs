import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SEMVER_PART = /^(?:0|[1-9]\d*)$/;
const SEMVER_FULL = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseSemver(raw) {
  if (typeof raw !== "string") throw new Error(`Invalid SemVer: ${String(raw)}`);
  const match = SEMVER_FULL.exec(raw.trim());
  if (!match) throw new Error(`Invalid SemVer: '${raw}'. Expected X.Y.Z or X.Y.Z-prerelease without leading zeros.`);
  const prerelease = match[4] ? match[4].split(".") : [];
  for (const id of prerelease) {
    if (/^\d+$/.test(id) && !SEMVER_PART.test(id)) {
      throw new Error(`Invalid SemVer prerelease numeric identifier with leading zero in '${raw}'.`);
    }
  }
  return {
    raw: raw.trim(),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

export function compareSemver(leftRaw, rightRaw) {
  const left = typeof leftRaw === "string" ? parseSemver(leftRaw) : leftRaw;
  const right = typeof rightRaw === "string" ? parseSemver(rightRaw) : rightRaw;
  for (const field of ["major", "minor", "patch"]) {
    if (left[field] !== right[field]) return left[field] > right[field] ? 1 : -1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const count = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < count; i += 1) {
    const a = left.prerelease[i];
    const b = right.prerelease[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNum = /^\d+$/.test(a);
    const bNum = /^\d+$/.test(b);
    if (aNum && bNum) return Number(a) > Number(b) ? 1 : -1;
    if (aNum !== bNum) return aNum ? -1 : 1;
    return a > b ? 1 : -1;
  }
  return 0;
}

export function bumpSemver(currentRaw, kind) {
  const parsed = parseSemver(currentRaw);
  if (parsed.prerelease.length > 0) {
    throw new Error(`Cannot apply '${kind}' bump to prerelease version '${currentRaw}'; provide an explicit version.`);
  }
  if (kind === "patch") return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  if (kind === "minor") return `${parsed.major}.${parsed.minor + 1}.0`;
  if (kind === "major") return `${parsed.major + 1}.0.0`;
  throw new Error(`Unsupported bump kind: '${kind}'.`);
}

export function readCargoPackageMeta(cargoPath) {
  const text = readFileSync(cargoPath, "utf8");
  let section = "";
  let name = null;
  let version = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (section !== "package" || !line || line.startsWith("#")) continue;
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"(?:\s*#.*)?$/.exec(line);
    if (!kv) continue;
    if (kv[1] === "name") name = kv[2];
    if (kv[1] === "version") version = kv[2];
  }
  if (!name || !version) throw new Error(`Missing [package] name or version in ${cargoPath}`);
  return { name, version };
}

export function listStableModules(repoRoot) {
  const pluginsDir = join(repoRoot, "src-tauri", "plugins");
  if (!existsSync(pluginsDir)) throw new Error(`Missing plugins directory: ${pluginsDir}`);
  const entries = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  const modules = [];
  for (const entry of entries) {
    const manifestPath = join(pluginsDir, entry.name, "module.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.status !== "stable") continue;
    if (manifest.slug !== entry.name) {
      throw new Error(`Module directory '${entry.name}' does not match manifest slug '${manifest.slug}'`);
    }
    if (manifest.id !== `taomni-plugin-${manifest.slug}`) {
      throw new Error(`Module '${manifest.slug}' has unexpected id '${manifest.id}'`);
    }
    if (!Array.isArray(manifest.platforms) || manifest.platforms.length === 0) {
      throw new Error(`Stable module '${manifest.slug}' must declare platforms`);
    }
    parseSemver(manifest.version);
    const cargoPath = join(pluginsDir, entry.name, "Cargo.toml");
    if (!existsSync(cargoPath)) {
      throw new Error(`Stable module '${manifest.slug}' is missing Cargo.toml`);
    }
    const cargo = readCargoPackageMeta(cargoPath);
    if (cargo.version !== manifest.version) {
      throw new Error(`Version mismatch for module '${manifest.slug}': module.json=${manifest.version}, Cargo.toml=${cargo.version}`);
    }
    modules.push({
      slug: manifest.slug,
      id: manifest.id,
      name: manifest.name || manifest.slug,
      version: manifest.version,
      platforms: manifest.platforms,
      manifestPath,
      cargoPath,
      packageName: cargo.name,
    });
  }
  return modules;
}

export function replaceJsonTopLevelVersion(text, oldVersion, nextVersion, fileLabel = "JSON manifest") {
  const parsed = JSON.parse(text);
  if (parsed.version !== oldVersion) {
    throw new Error(`${fileLabel} has version '${parsed.version}', expected '${oldVersion}'`);
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let count = 0;
  const updatedLines = lines.map((line) => {
    const match = /^( {2}"version"\s*:\s*")([^"]+)("\s*,?\s*)$/.exec(line);
    if (!match) return line;
    count += 1;
    if (match[2] !== oldVersion) {
      throw new Error(`${fileLabel} version line '${match[2]}' does not match '${oldVersion}'`);
    }
    return `${match[1]}${nextVersion}${match[3]}`;
  });
  if (count !== 1) throw new Error(`Expected exactly 1 top-level version line in ${fileLabel}, found ${count}`);
  const updated = updatedLines.join(eol);
  if (JSON.parse(updated).version !== nextVersion) {
    throw new Error(`Updated ${fileLabel} failed version verification`);
  }
  return updated;
}

export function replaceCargoPackageVersion(text, oldVersion, nextVersion, fileLabel = "Cargo.toml") {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let section = "";
  let count = 0;
  const updatedLines = lines.map((line) => {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      section = header[1].trim();
      return line;
    }
    if (section !== "package") return line;
    const match = /^(\s*version\s*=\s*")([^"]+)("(?:\s*#.*)?)$/.exec(line);
    if (!match) return line;
    count += 1;
    if (match[2] !== oldVersion) {
      throw new Error(`${fileLabel} [package].version '${match[2]}' does not match '${oldVersion}'`);
    }
    return `${match[1]}${nextVersion}${match[3]}`;
  });
  if (count !== 1) throw new Error(`Expected exactly 1 [package] version line in ${fileLabel}, found ${count}`);
  return updatedLines.join(eol);
}
