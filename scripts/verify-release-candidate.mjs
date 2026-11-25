import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, createReadStream, existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const CORE_TARGETS = ["ubuntu-22.04", "windows-latest", "macos-aarch64", "macos-x86_64"];
const MODULE_TARGETS = ["linux-x86_64", "windows-x86_64", "darwin-aarch64", "darwin-x86_64"];
const CANDIDATE_SCHEMA = "taomni.release-candidate.v1";
const macosRecord = "macos-build-identity.json";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

async function digest(path) {
  if (!lstatSync(path).isFile()) throw new Error(`Expected a regular file at ${path}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function selectCandidate({ producer, artifacts, repository, source, runId, version, modules }) {
  if (!/^[1-9]\d*$/.test(runId) || !/^[a-f0-9]{40}$/.test(source)
      || String(producer.id) !== runId || producer.head_sha !== source
      || producer.path !== ".github/workflows/release.yml" || producer.event !== "workflow_dispatch"
      || producer.status !== "completed" || producer.conclusion !== "success"
      || !Number.isSafeInteger(producer.run_attempt) || producer.run_attempt < 1
      || producer.repository?.full_name !== repository || producer.head_repository?.full_name !== repository) {
    throw new Error("Use a successful artifact-only Release Bundle run of the selected source in this repository");
  }
  const selectedIds = new Set();
  const exact = (name) => {
    const matches = artifacts.filter((artifact) => artifact.name === name && artifact.expired === false);
    if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id) || matches[0].id < 1
        || selectedIds.has(matches[0].id)) {
      throw new Error(`Expected exactly one available candidate artifact ${name}`);
    }
    const { id } = matches[0];
    selectedIds.add(id);
    return { id, name };
  };
  const core = CORE_TARGETS.map((target) => exact(`taomni-${version}-${target}`));
  const updater = exact(`modular-candidate-updater-${runId}`);
  const packages = modules.flatMap((manifest) => {
    const { slug, id, status, platforms, version: moduleVersion } = manifest;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || id !== `taomni-plugin-${slug}`
        || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(moduleVersion)
        || status !== "stable" || !manifest.description?.trim() || !Array.isArray(platforms)
        || !platforms.length || new Set(platforms).size !== platforms.length
        || platforms.some((platform) => !MODULE_TARGETS.includes(platform))) {
      throw new Error(`Invalid stable release manifest for ${slug}`);
    }
    return platforms.map((platform) => ({
      ...exact(`module-signed-${slug}-${platform}-${runId}`),
      slug, moduleId: id, platform, version: moduleVersion, nativeHost: Boolean(manifest.entry?.host),
    }));
  });
  return { repository, sourceSha: source, runId, runAttempt: String(producer.run_attempt), version,
    core, updater, packages, modules: modules.map(({ slug }) => slug).sort() };
}

export function verifyTagRefs(remoteRefs, tag, source) {
  const refs = new Map(remoteRefs.trim().split("\n").filter(Boolean).map((line) => line.split("\t").reverse()));
  const ref = `refs/tags/${tag}`;
  const existing = refs.get(ref + "^{}") ?? refs.get(ref);
  if (existing && existing !== source) {
    throw new Error(`Existing tag ${tag} resolves to a different source than the selected candidate`);
  }
}

export function verifyCandidateReceipt(receipt, selection) {
  const fields = ["repository", "sourceSha", "runId", "version", "modules"];
  // GitHub retains successful job artifacts when only failed jobs are rerun.
  const updaterAttempt = receipt.runAttempt;
  if (receipt.schema !== CANDIDATE_SCHEMA
      || typeof updaterAttempt !== "string" || !/^[1-9]\d*$/.test(updaterAttempt)
      || Number(updaterAttempt) > Number(selection.runAttempt)
      || fields.some((field) => !isDeepStrictEqual(receipt[field], selection[field]))) {
    throw new Error("Candidate receipt does not bind this producer, attempt, version and module selection");
  }
}

function verifyMacosBuilds(bundles, selection, certificate) {
  const requiredCertificate = (certificate ?? "").toUpperCase();
  if (!/^[A-F0-9]{40}$/.test(requiredCertificate)) {
    throw new Error("Fixed macOS signing requires MACOS_SIGNING_CERT_SHA1");
  }
  for (const arch of ["aarch64", "x86_64"]) {
    const record = readJson(join(bundles, `taomni-${selection.version}-macos-${arch}`, macosRecord));
    if (record.sourceSha !== selection.sourceSha || record.arch !== arch
        || record.certificateSha1 !== requiredCertificate
        || !["developer-id", "self-signed"].includes(record.signingMode) || record.staticKerberos !== false) {
      throw new Error(`Candidate macOS ${arch} package differs from the production signing configuration`);
    }
  }
  return requiredCertificate;
}

function readChecksums(path) {
  const result = new Map();
  for (const line of readFileSync(path, "utf8").trimEnd().split("\n")) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._+-]*)$/.exec(line);
    if (!match || result.has(match[2])) throw new Error("Invalid candidate core checksum inventory");
    result.set(match[2], match[1]);
  }
  return result;
}

export async function reuseCoreAssets(evidence, staged) {
  const checksums = readChecksums(join(evidence, "SHA256SUMS"));
  if (!isDeepStrictEqual([...checksums.keys()].sort(), readdirSync(staged).sort())) {
    throw new Error("Candidate core asset filenames differ from the staged release");
  }
  const original = join(evidence, "latest.json");
  if (await digest(original) !== checksums.get("latest.json")) {
    throw new Error("Candidate updater manifest differs from its checksum");
  }
  const candidateManifest = readJson(original);
  const releaseManifest = readJson(join(staged, "latest.json"));
  if (candidateManifest.version !== releaseManifest.version
      || !isDeepStrictEqual(candidateManifest.platforms, releaseManifest.platforms)) {
    throw new Error("Candidate updater targets differ from the staged release");
  }
  for (const [name, expected] of checksums) {
    if (name !== "latest.json" && await digest(join(staged, name)) !== expected) {
      throw new Error(`Candidate core asset bytes differ for ${name}`);
    }
  }
  copyFileSync(original, join(staged, "latest.json"));
}

async function verifyModuleAssets(directory, selection, certificate) {
  const result = [];
  for (const item of selection.packages) {
    const artifact = join(directory, item.name);
    const signedPath = join(artifact, "signed-module");
    const payload = existsSync(signedPath) ? signedPath : artifact;
    const record = readJson(join(payload, "provenance.json"));
    const archive = `${item.moduleId}-${item.version}-${item.platform}.taomni-plugin`;
    const signature = archive + ".minisig";
    if (record.schema !== "taomni.plugin-package.v1" || record.sourceSha !== selection.sourceSha
        || record.id !== item.moduleId || record.slug !== item.slug || record.version !== item.version
        || record.platform !== item.platform || record.archive !== archive || record.signature !== signature
        || await digest(join(payload, archive)) !== record.sha256) {
      throw new Error(`Candidate module package differs from its source receipt: ${item.name}`);
    }
    if (item.nativeHost && item.platform.startsWith("darwin-")) {
      const identity = readFileSync(join(artifact, "macos-signing", "identity.txt"), "utf8").split(/\r?\n/);
      for (const field of [`sourceSha=${selection.sourceSha}`, `platform=${item.platform}`, `certificateSha1=${certificate}`]) {
        if (!identity.includes(field)) throw new Error(`Candidate macOS module signature differs for ${item.name}`);
      }
    }
    result.push({ artifactId: item.id, ...record, signatureSha256: await digest(join(payload, signature)) });
  }
  return result;
}

async function main([operation, directory], env) {
  if (operation === "record-macos") {
    writeJson(join(directory, macosRecord), {
      sourceSha: env.GITHUB_SHA, arch: env.BUNDLE_ARCH, signingMode: env.MACOS_SIGNING_MODE,
      certificateSha1: env.MACOS_SIGNING_CERT_SHA1 ?? "", staticKerberos: env.MACOS_STATIC_KRB5 === "true",
      runnerImage: env.ImageOS, runnerImageVersion: env.ImageVersion,
    });
  } else if (operation === "record-updater") {
    writeJson(join(directory, "receipt.json"), {
      schema: CANDIDATE_SCHEMA, sourceSha: env.GITHUB_SHA, repository: env.GITHUB_REPOSITORY,
      runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, version: env.VERSION,
      modules: JSON.parse(env.MODULE_SELECTION).sort(), runnerImage: `${env.ImageOS}/${env.ImageVersion}`,
    });
  } else if (operation === "select") {
    const modules = JSON.parse(env.MODULE_SELECTION).map((slug) => readJson(join("src-tauri/plugins", slug, "module.json")));
    const selection = selectCandidate({ producer: readJson(join(directory, "producer.json")),
      artifacts: readJson(join(directory, "artifacts.json")).flatMap((page) => page.artifacts),
      repository: env.GITHUB_REPOSITORY, source: env.CANDIDATE_SOURCE || env.GITHUB_SHA, runId: env.CANDIDATE_RUN,
      version: env.VERSION, modules });
    verifyTagRefs(readFileSync(join(directory, "tag-refs.txt"), "utf8"), env.TAG, selection.sourceSha);
    writeJson(join(directory, "selection.json"), selection);
    appendFileSync(env.GITHUB_OUTPUT, [
      `core_artifacts=${selection.core.map(({ id }) => id).join(",")}`,
      `updater_artifact=${selection.updater.id}`,
      `module_artifacts=${selection.packages.map(({ id }) => id).join(",")}`,
    ].join("\n") + "\n");
  } else if (operation === "verify") {
    const selection = readJson(join(directory, "selection.json"));
    const updater = join(directory, "updater");
    const updaterReceipt = readJson(join(updater, "receipt.json"));
    verifyCandidateReceipt(updaterReceipt, selection);
    const certificate = verifyMacosBuilds("core-bundles", selection, env.MACOS_SIGNING_CERT_SHA1);
    await reuseCoreAssets(updater, "updater-assets");
    const modules = await verifyModuleAssets("signed-module-artifacts", selection, certificate);
    writeJson(join(directory, "verified-assets.json"), {
      selection, updaterRunAttempt: updaterReceipt.runAttempt,
      core: Object.fromEntries(readChecksums(join(updater, "SHA256SUMS"))), modules,
    });
  } else {
    throw new Error("Usage: node scripts/verify-release-candidate.mjs <operation> <directory>");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2), process.env);
}
