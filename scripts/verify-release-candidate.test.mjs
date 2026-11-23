import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { reuseCoreAssets, selectCandidate, verifyCandidateReceipt, verifyTagRefs } from "./verify-release-candidate.mjs";

const source = "1".repeat(40);
const certificate = "B".repeat(40);
const repository = "engcapa/taomni";
const runId = "42";
const version = "0.6.0";
const moduleManifest = { id: "taomni-plugin-mail", slug: "mail", version: "0.1.45", status: "stable",
  description: "Mail client", platforms: ["darwin-aarch64"], entry: { host: "taomni-plugin-mail" } };
const coreNames = ["ubuntu-22.04", "windows-latest", "macos-aarch64", "macos-x86_64"]
  .map((target) => `taomni-${version}-${target}`);
const packageName = `module-signed-mail-darwin-aarch64-${runId}`;
const producer = {
  id: Number(runId), head_sha: source, path: ".github/workflows/release.yml", event: "workflow_dispatch",
  status: "completed", conclusion: "success", run_attempt: 2,
  repository: { full_name: repository }, head_repository: { full_name: repository },
};
const artifacts = [...coreNames, `modular-candidate-updater-${runId}`, packageName]
  .map((name, index) => ({ name, id: 100 + index, expired: false }));
const candidate = { producer, artifacts, repository, source, runId, version, modules: [moduleManifest] };
const checksum = (contents) => createHash("sha256").update(contents).digest("hex");

test("selects immutable identifiers from the same successful producer and the requested module set", () => {
  const result = selectCandidate(candidate);
  assert.deepEqual(result.core, artifacts.slice(0, 4).map(({ id, name }) => ({ id, name })));
  assert.equal(result.updater.id, 104);
  assert.equal(result.packages[0].id, 105);
  assert.deepEqual(result.modules, ["mail"]);
  assert.deepEqual(selectCandidate({ ...candidate, modules: [] }).packages, []);
  for (const overrides of [
    { head_sha: "2".repeat(40) }, { head_repository: { full_name: "another/repository" } },
    { conclusion: "failure" }, { status: "in_progress" }, { event: "push" }, { path: ".github/workflows/qa.yml" },
  ]) {
    assert.throws(() => selectCandidate({ ...candidate, producer: { ...producer, ...overrides } }),
      /successful artifact-only Release Bundle/);
  }
});

test("requires every available architecture and rejects a provisional publication", () => {
  assert.throws(() => selectCandidate({ ...candidate, artifacts: artifacts.slice(0, -1) }), /candidate artifact module-signed/);
  const [unavailable, ...remaining] = artifacts;
  assert.throws(() => selectCandidate({ ...candidate, artifacts: [{ ...unavailable, expired: true }, ...remaining] }),
    /candidate artifact taomni/);
  assert.throws(() => selectCandidate({ ...candidate, artifacts: [...artifacts, { ...unavailable, id: 888 }] }),
    /exactly one available/);
  assert.throws(() => selectCandidate({ ...candidate, modules: [{ ...moduleManifest, status: "provisional" }] }),
    /Invalid stable release manifest/);
});

test("binds the tag and receipt to the source, package selection and exact attempt", () => {
  const tag = `v${version}`;
  verifyTagRefs("", tag, source);
  verifyTagRefs(`${source}\trefs/tags/${tag}\n`, tag, source);
  verifyTagRefs(`${certificate}\trefs/tags/${tag}\n${source}\trefs/tags/${tag}^{}\n`, tag, source);
  assert.throws(() => verifyTagRefs(`${certificate}\trefs/tags/${tag}\n`, tag, source), /different source/);
  const record = selectCandidate(candidate);
  const receipt = { schema: "taomni.release-candidate.v1", repository, sourceSha: source, runId, runAttempt: "2",
    version, modules: ["mail"] };
  verifyCandidateReceipt(receipt, record);
  assert.throws(() => verifyCandidateReceipt({ ...receipt, runAttempt: "1" }, record), /does not bind/);
  assert.throws(() => verifyCandidateReceipt({ ...receipt, modules: [] }, record), /does not bind/);
  assert.throws(() => verifyCandidateReceipt({ ...receipt, version: "0.5.12" }, record), /does not bind/);
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "taomni-candidate-unit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name, contents) => {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  };
  const staged = join(root, "updater-assets");
  const evidence = join(root, "release-candidate", "updater");
  const file = `Taomni_${version}_aarch64.dmg`;
  const installers = "exact core candidate bytes";
  const manifest = { version, notes: "Verified candidate", pub_date: "2026-11-23T08:00:00Z",
    platforms: { "darwin-aarch64": { url: "https://example.com/release", signature: "example" } } };
  put("release-candidate/updater/latest.json", manifest);
  put("release-candidate/updater/SHA256SUMS", `${checksum(installers)}  ${file}\n${checksum(JSON.stringify(manifest))}  latest.json\n`);
  put(`updater-assets/${file}`, installers);
  put("updater-assets/latest.json", { ...manifest, notes: "Restaged", pub_date: "2026-11-23T08:10:00Z" });
  return { root, put, evidence, staged, file };
}

test("reuses exact installer and manifest bytes and rejects missing or replaced core assets", async (t) => {
  const { put, evidence, staged, file } = fixture(t);
  await reuseCoreAssets(evidence, staged);
  assert.deepEqual(readFileSync(join(staged, "latest.json")), readFileSync(join(evidence, "latest.json")));
  put(`updater-assets/${file}`, "different signed installer");
  await assert.rejects(reuseCoreAssets(evidence, staged), /Candidate core asset bytes differ/);
  put("updater-assets/extra-asset", "not in the selected candidate");
  await assert.rejects(reuseCoreAssets(evidence, staged), /asset filenames differ/);
});

test("release staging records selected module bytes and requires the candidate production signing mode", (t) => {
  const { root, put } = fixture(t);
  const selection = selectCandidate(candidate);
  const receipt = { ...selection, schema: "taomni.release-candidate.v1" };
  put("release-candidate/selection.json", selection);
  put("release-candidate/updater/receipt.json", receipt);
  const macos = { sourceSha: source, signingMode: "self-signed", certificateSha1: certificate, staticKerberos: false };
  for (const arch of ["aarch64", "x86_64"]) {
    put(`core-bundles/taomni-${version}-macos-${arch}/macos-build-identity.json`, { ...macos, arch });
  }
  const { id: moduleId, slug, version: moduleVersion } = moduleManifest;
  const platform = "darwin-aarch64";
  const archive = `${moduleId}-${moduleVersion}-${platform}.taomni-plugin`;
  const pkgPath = `signed-module-artifacts/${packageName}`;
  put(`${pkgPath}/signed-module/${archive}`, "candidate package");
  put(`${pkgPath}/signed-module/${archive}.minisig`, "unchanged detached signature");
  put(`${pkgPath}/signed-module/provenance.json`, { schema: "taomni.plugin-package.v1", id: moduleId, slug,
    version: moduleVersion, platform, archive, sourceSha: source, sha256: checksum("candidate package"),
    signature: archive + ".minisig" });
  put(`${pkgPath}/macos-signing/identity.txt`, `sourceSha=${source}\nplatform=${platform}\ncertificateSha1=${certificate}\n`);
  const verify = () => spawnSync(process.execPath, [fileURLToPath(new URL("./verify-release-candidate.mjs", import.meta.url)),
    "verify", "release-candidate"], { cwd: root, env: { ...process.env, MACOS_SIGNING_CERT_SHA1: certificate }, encoding: "utf8" });
  const result = verify();
  assert.equal(result.status, 0, result.stderr);
  const { modules } = JSON.parse(readFileSync(join(root, "release-candidate", "verified-assets.json"), "utf8"));
  assert.equal(modules[0].artifactId, 105);
  assert.equal(modules[0].signatureSha256, checksum("unchanged detached signature"));
  put(`${pkgPath}/signed-module/${archive}`, "changed package");
  assert.match(verify().stderr, /Candidate module package differs/);
  const arm = `core-bundles/taomni-${version}-macos-aarch64/macos-build-identity.json`;
  put(arm, { ...macos, arch: "aarch64", staticKerberos: true });
  assert.match(verify().stderr, /differs from the production signing configuration/);
});
