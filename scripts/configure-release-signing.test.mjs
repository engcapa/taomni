import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupMacosCertificate, githubEnvironment, importMacosCertificate, releaseSigningPlan, security, signingCertificate } from "./configure-release-signing.mjs";

const fingerprint = "0123456789ABCDEF0123456789ABCDEF01234567";

test("keychain commands have a hard timeout, redact sensitive failures and restrict trust to hosted CI", () => {
  let options;
  const execute = (command, args, opts) => {
    options = opts;
    return { status: null, error: { code: "ETIMEDOUT" }, stderr: "private password data" };
  };
  assert.throws(() => security(["import", "private.p12", "-P", "private password"], "import .p12", {}, execute), (error) => {
    assert.match(error.message, /timed out after 60 seconds/);
    assert(!error.message.includes("private"));
    return true;
  });
  assert.equal(options.timeout, 60_000);
  assert.equal(options.killSignal, "SIGKILL");
  assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
  for (const operation of ["add-trusted-cert", "remove-trusted-cert"]) {
    assert.throws(() => security([operation], "test trust operation", {}, () => assert.fail("local trust must not be touched")), /disposable GitHub-hosted/);
  }
});
function macos(overrides = {}) {
  return {
    RELEASE_PLATFORM: "macOS", RELEASE_TAG: "v0.4.30",
    TAURI_SIGNING_PRIVATE_KEY: "fixed-updater-key\nsecond-line",
    APPLE_CERTIFICATE: "cDEy", APPLE_CERTIFICATE_PASSWORD: "p12-password",
    APPLE_SIGNING_IDENTITY: "Taomni Local Code Signing", MACOS_SIGNING_CERT_SHA1: fingerprint,
    ...overrides,
  };
}

test("self-signed releases use the pinned identity without Apple notarization credentials", () => {
  const plan = releaseSigningPlan(macos());
  assert.equal(plan.mode, "self-signed");
  assert.equal(plan.notarize, false);
  assert.equal(plan.environment.APPLE_SIGNING_IDENTITY, fingerprint);
  assert.equal(plan.environment.TAURI_SIGNING_PRIVATE_KEY, "fixed-updater-key\nsecond-line");
  assert.equal(JSON.parse(plan.environment.TAURI_RELEASE_CONFIG).bundle.macOS.hardenedRuntime, false);
  assert.equal(JSON.parse(plan.environment.TAURI_RELEASE_CONFIG).bundle.createUpdaterArtifacts, true);
  for (const name of ["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"]) {
    assert.equal(plan.environment[name], undefined);
  }
});

test("Developer ID signing works with or without a complete optional notarization account", () => {
  const env = macos({ APPLE_SIGNING_IDENTITY: "Developer ID Application: Example (TEAM123456)" });
  assert.equal(releaseSigningPlan(env).mode, "developer-id");
  assert.equal(releaseSigningPlan(env).notarize, false);
  assert.equal(JSON.parse(releaseSigningPlan(env).environment.TAURI_RELEASE_CONFIG).bundle.macOS.hardenedRuntime, true);
  Object.assign(env, { APPLE_ID: "apple-id", APPLE_PASSWORD: "app-password", APPLE_TEAM_ID: "TEAM123456" });
  const plan = releaseSigningPlan(env);
  assert.equal(plan.notarize, true);
  assert.equal(plan.environment.APPLE_TEAM_ID, "TEAM123456");
});

test("releases on every platform require an updater key, but artifact-only builds can omit it", () => {
  for (const RELEASE_PLATFORM of ["macOS", "Linux", "Windows"]) {
    assert.throws(() => releaseSigningPlan(macos({ RELEASE_PLATFORM, TAURI_SIGNING_PRIVATE_KEY: "" })), /TAURI_SIGNING_PRIVATE_KEY is required/);
    const artifactPlan = releaseSigningPlan({ RELEASE_PLATFORM, RELEASE_TAG: "" });
    assert.equal(JSON.parse(artifactPlan.environment.TAURI_RELEASE_CONFIG).bundle.createUpdaterArtifacts, false);
  }
  assert.equal(releaseSigningPlan({ RELEASE_PLATFORM: "macOS" }).mode, "adhoc");
});

test("artifact-only versions are applied to the Tauri bundle without changing signing or updater keys", () => {
  for (const RELEASE_PLATFORM of ["macOS", "Linux", "Windows"]) {
    const plan = releaseSigningPlan(macos({ RELEASE_PLATFORM, RELEASE_TAG: "", RELEASE_TEST_VERSION: "0.4.31-permission.1" }));
    assert.equal(JSON.parse(plan.environment.TAURI_RELEASE_CONFIG).version, "0.4.31-permission.1");
    assert.equal(plan.environment.TAURI_SIGNING_PRIVATE_KEY, "fixed-updater-key\nsecond-line");
    if (RELEASE_PLATFORM === "macOS") assert.equal(plan.environment.APPLE_SIGNING_IDENTITY, fingerprint);
  }
  assert.throws(() => releaseSigningPlan(macos({ RELEASE_TEST_VERSION: "0.4.31-permission.1" })), /empty tag/);
  assert.throws(() => releaseSigningPlan(macos({ RELEASE_TAG: "", RELEASE_TEST_VERSION: "0.4.31\n" })), /valid SemVer/);
});

for (const name of ["APPLE_CERTIFICATE", "APPLE_SIGNING_IDENTITY", "MACOS_SIGNING_CERT_SHA1"]) {
  test(`missing ${name} never silently downgrades a macOS release or a partially configured workflow build`, () => {
    assert.throws(() => releaseSigningPlan(macos({ [name]: "" })), /refusing to fall back/);
    assert.throws(() => releaseSigningPlan(macos({ [name]: "", RELEASE_TAG: "" })), /refusing to fall back/);
  });
}

test("rejects ad-hoc identities, malformed fingerprints and incomplete/incompatible notarization", () => {
  assert.throws(() => releaseSigningPlan(macos({ APPLE_SIGNING_IDENTITY: "-" })), /ad-hoc identity/);
  assert.throws(() => releaseSigningPlan(macos({ MACOS_SIGNING_CERT_SHA1: "certificate-name" })), /fingerprint/);
  assert.throws(() => releaseSigningPlan(macos({ APPLE_ID: "apple-id" })), /Incomplete notarization/);
  assert.throws(() => releaseSigningPlan(macos({ APPLE_ID: "apple-id", APPLE_PASSWORD: "password", APPLE_TEAM_ID: "TEAM123456" })), /cannot be Apple notarized/);
});

test("empty key/p12 passwords are supported and multiline secrets survive GitHub's env format", () => {
  assert.equal(releaseSigningPlan(macos({ APPLE_CERTIFICATE_PASSWORD: "" })).environment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, "");
  const values = { TAURI_SIGNING_PRIVATE_KEY: "line-one\nline-two\n", TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "", APPLE_PASSWORD: "literal `command` $(command)\nsecond-line" };
  const encoded = githubEnvironment(values);
  const decoded = {};
  const lines = encoded.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    const [name, delimiter] = lines[i].split("<<");
    const content = [];
    while (lines[++i] !== delimiter) content.push(lines[i]);
    decoded[name] = content.join("\n");
  }
  assert.deepEqual(decoded, values);
});

test("imports an ordinary self-signed certificate and checks its private key before exposing signing env", (t) => {
  const root = mkdtempSync(join(tmpdir(), "taomni-signing-unit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pemPath = join(root, "test.pem");
  // This disposable test key never touches a host keychain or signs an app.
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(root, "test.key"), "-out", pemPath, "-days", "2", "-subj", "/CN=Taomni Local Code Signing"], { stdio: "ignore" });
  const pem = readFileSync(pemPath, "utf8");
  const sha1 = new X509Certificate(pem).fingerprint.replaceAll(":", "");
  const env = macos({ RUNNER_TEMP: root, GITHUB_ENV: join(root, "github-env"), MACOS_SIGNING_CERT_SHA1: sha1 });
  const calls = [];
  const runSecurity = (args) => {
    calls.push(args);
    if (args[0] === "find-certificate") return pem;
    if (args[0] === "find-identity") return `1) ${sha1} "Taomni Local Code Signing"\n1 valid identities found`;
    if (args[0] === "list-keychains" && !args.includes("-s")) return '    "/tmp/login.keychain-db"\n';
    return "";
  };
  importMacosCertificate(env, releaseSigningPlan(env), runSecurity);
  const trust = calls.find((args) => args[0] === "add-trusted-cert");
  assert(trust.includes("codeSign"));
  assert(trust.includes("-d"));
  const importCall = calls.find((args) => args[0] === "import");
  assert(!existsSync(importCall[1]), "the p12 must be removed after import");
  const exported = readFileSync(env.GITHUB_ENV, "utf8");
  assert(exported.includes(`APPLE_SIGNING_IDENTITY<<`));
  assert(exported.includes(sha1));
  assert(!exported.includes("p12-password"));
  assert(!exported.includes("APPLE_CERTIFICATE<<"));
  assert.throws(() => signingCertificate(pem, env.APPLE_SIGNING_IDENTITY, fingerprint, "self-signed"), /does not match MACOS_SIGNING_CERT_SHA1/);
  assert.throws(() => signingCertificate(pem, "Different Name", sha1, "self-signed"), /does not match APPLE_SIGNING_IDENTITY/);

  writeFileSync(env.GITHUB_ENV, "");
  assert.throws(() => importMacosCertificate(env, releaseSigningPlan(env), (args) => args[0] === "find-identity" ? "0 valid identities found" : runSecurity(args)), /no valid code-signing identity/);
  assert(!readFileSync(env.GITHUB_ENV, "utf8").includes("APPLE_SIGNING_IDENTITY<<"));
});

test("cleanup removes the temporary keychain/files even when removing CI trust fails, and rejects unrelated paths", (t) => {
  const root = mkdtempSync(join(tmpdir(), "taomni-signing-cleanup-unit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const failTrust of [false, true]) {
    const workDir = mkdtempSync(join(root, "taomni-signing-"));
    writeFileSync(join(workDir, "certificate.pem"), "test public certificate");
    const commands = [];
    const cleanup = () => cleanupMacosCertificate({ RUNNER_TEMP: root, MACOS_SIGNING_WORK_DIR: workDir }, (args) => {
      commands.push(args[0]);
      if (args[0] === "remove-trusted-cert" && failTrust) throw new Error("test trust removal failure");
      return "";
    });
    if (failTrust) assert.throws(cleanup, /test trust removal failure/);
    else cleanup();
    assert.deepEqual(commands, ["remove-trusted-cert", "delete-keychain"]);
    assert(!existsSync(workDir));
  }
  assert.throws(() => cleanupMacosCertificate({ RUNNER_TEMP: root, MACOS_SIGNING_WORK_DIR: root }), /unexpected signing directory/);
  assert(existsSync(root));
});
