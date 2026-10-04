import { randomBytes, X509Certificate } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { validateTestVersion } from "./resolve-release-build.mjs";

/** The updater key and the macOS certificate serve independent trust chains. */
export function releaseSigningPlan(env) {
  const release = Boolean(env.RELEASE_TAG);
  const platform = env.RELEASE_PLATFORM;
  const config = { bundle: { createUpdaterArtifacts: Boolean(env.TAURI_SIGNING_PRIVATE_KEY) } };
  validateTestVersion(env.RELEASE_TEST_VERSION, env.RELEASE_TAG);
  if (env.RELEASE_TEST_VERSION) config.version = env.RELEASE_TEST_VERSION;
  const environment = { TAURI_RELEASE_CONFIG: JSON.stringify(config) };
  if (!env.TAURI_SIGNING_PRIVATE_KEY && release) {
    throw new Error("TAURI_SIGNING_PRIVATE_KEY is required for releases; keep the key matching plugins.updater.pubkey.");
  }
  if (env.TAURI_SIGNING_PRIVATE_KEY) {
    environment.TAURI_SIGNING_PRIVATE_KEY = env.TAURI_SIGNING_PRIVATE_KEY;
    environment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "";
  }
  if (platform !== "macOS") return { environment, mode: null, notarize: false };

  const signingNames = ["APPLE_CERTIFICATE", "APPLE_SIGNING_IDENTITY", "MACOS_SIGNING_CERT_SHA1"];
  const hasCertificate = signingNames.some((name) => Boolean(env[name])) || Boolean(env.APPLE_CERTIFICATE_PASSWORD);
  const missing = signingNames.filter((name) => !env[name]);
  if ((release || hasCertificate) && missing.length) {
    throw new Error(`Fixed macOS signing requires ${missing.join(", ")}; refusing to fall back to ad-hoc signing.`);
  }
  const notarizationNames = ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"];
  const hasNotarization = notarizationNames.some((name) => Boolean(env[name]));
  const missingNotarization = notarizationNames.filter((name) => !env[name]);
  if (hasNotarization && missingNotarization.length) {
    throw new Error(`Incomplete notarization credentials: ${missingNotarization.join(", ")}.`);
  }
  if (hasNotarization && !hasCertificate) throw new Error("Notarization requires a Developer ID signing certificate.");

  let mode = "adhoc";
  if (hasCertificate) {
    if (env.APPLE_SIGNING_IDENTITY === "-" || /[\r\n]/.test(env.APPLE_SIGNING_IDENTITY)) {
      throw new Error("APPLE_SIGNING_IDENTITY must be the full certificate name, not an ad-hoc identity.");
    }
    if (!/^[a-fA-F0-9]{40}$/.test(env.MACOS_SIGNING_CERT_SHA1)) {
      throw new Error("MACOS_SIGNING_CERT_SHA1 must be the certificate's 40-digit SHA-1 fingerprint.");
    }
    mode = env.APPLE_SIGNING_IDENTITY.startsWith("Developer ID Application:") ? "developer-id" : "self-signed";
    if (hasNotarization && mode !== "developer-id") {
      throw new Error("Self-signed certificates cannot be Apple notarized; remove APPLE_ID, APPLE_PASSWORD and APPLE_TEAM_ID.");
    }
    environment.MACOS_SIGNING_CERT_SHA1 = env.MACOS_SIGNING_CERT_SHA1.toUpperCase();
    // Import ourselves: Tauri's APPLE_CERTIFICATE importer only resolves Apple
    // certificate prefixes. Its APPLE_SIGNING_IDENTITY path accepts fingerprints.
    environment.APPLE_SIGNING_IDENTITY = environment.MACOS_SIGNING_CERT_SHA1;
  }
  if (hasNotarization) {
    for (const name of notarizationNames) environment[name] = env[name];
  }
  environment.MACOS_SIGNING_MODE = mode;
  environment.MACOS_NOTARIZE = String(hasNotarization);
  // Self-signed certificates have no Apple Team ID. Hardened runtime's
  // library validation would reject Taomni's bundled krb5 dylibs in that mode.
  config.bundle.macOS = { hardenedRuntime: mode !== "self-signed" };
  environment.TAURI_RELEASE_CONFIG = JSON.stringify(config);
  return { environment, mode, notarize: hasNotarization };
}

// GitHub's single-line NAME=value syntax corrupts multiline keys/passwords.
export function githubEnvironment(values) {
  return Object.entries(values).map(([name, value]) => {
    let delimiter;
    do { delimiter = `taomni_${randomBytes(16).toString("hex")}`; } while (value.includes(delimiter));
    return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
  }).join("");
}

function exportEnvironment(env, values) {
  if (!env.GITHUB_ENV) throw new Error("GITHUB_ENV is required.");
  appendFileSync(env.GITHUB_ENV, githubEnvironment(values));
}

export function security(args, purpose, env = process.env, execute = spawnSync) {
  const trustOperation = ["add-trusted-cert", "remove-trusted-cert"].includes(args[0]);
  if (trustOperation && (env.GITHUB_ACTIONS !== "true" || env.RUNNER_ENVIRONMENT !== "github-hosted")) {
    throw new Error("CI certificate trust may only be configured on a disposable GitHub-hosted runner.");
  }
  // Hosted macOS runners support passwordless sudo. Admin trust avoids the
  // interactive authorization dialog required for user-domain trust updates.
  if (env.GITHUB_ACTIONS === "true") console.log(`macOS keychain: ${purpose}.`);
  const result = execute(trustOperation ? "sudo" : "security", trustOperation ? ["-n", "security", ...args] : args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, killSignal: "SIGKILL",
  });
  // security arguments include passwords; never include arguments or captured
  // output in errors or logs (set-key-partition-list also prints key metadata).
  if (result.error || result.status !== 0) {
    const detail = result.error?.code === "ETIMEDOUT" ? " (timed out after 60 seconds)" : "";
    throw new Error(`macOS keychain operation failed: ${purpose}${detail}.`);
  }
  return result.stdout;
}

export function signingCertificate(pemList, expectedName, expectedFingerprint, mode) {
  const certificates = (pemList.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [])
    .map((pem) => new X509Certificate(pem));
  const certificate = certificates.find((cert) => cert.fingerprint.replaceAll(":", "") === expectedFingerprint);
  if (!certificate) throw new Error("Imported certificate does not match MACOS_SIGNING_CERT_SHA1; keep the same certificate across releases.");
  if (certificate.subject.match(/^CN=(.+)$/m)?.[1] !== expectedName) {
    throw new Error("Imported certificate does not match APPLE_SIGNING_IDENTITY.");
  }
  if (Date.now() < Date.parse(certificate.validFrom) || Date.now() >= Date.parse(certificate.validTo)) {
    throw new Error("The signing certificate is not currently valid.");
  }
  if (mode === "self-signed" && !(certificate.checkIssued(certificate) && certificate.verify(certificate.publicKey))) {
    throw new Error("The non-Developer-ID signing path requires a self-signed code-signing certificate.");
  }
  return certificate;
}

export function importMacosCertificate(env, plan, runSecurity = security) {
  const workDir = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), "taomni-signing-"));
  chmodSync(workDir, 0o700);
  const keychain = join(workDir, "signing.keychain-db");
  const certificatePath = join(workDir, "certificate.pem");
  const p12Path = join(workDir, "certificate.p12");
  const keychainPassword = randomBytes(32).toString("hex");
  // Export cleanup paths before any operation that can fail. The workflow's
  // always() step removes the temporary keychain and CI-only trust setting.
  exportEnvironment(env, { MACOS_SIGNING_WORK_DIR: workDir });
  const encoded = env.APPLE_CERTIFICATE.replace(/\s/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error("APPLE_CERTIFICATE must be a base64-encoded .p12 file.");
  }
  writeFileSync(p12Path, Buffer.from(encoded, "base64"), { mode: 0o600 });
  try {
    runSecurity(["create-keychain", "-p", keychainPassword, keychain], "create temporary keychain");
    runSecurity(["set-keychain-settings", "-lut", "21600", keychain], "set keychain lifetime");
    runSecurity(["unlock-keychain", "-p", keychainPassword, keychain], "unlock temporary keychain");
    runSecurity(["import", p12Path, "-k", keychain, "-P", env.APPLE_CERTIFICATE_PASSWORD ?? "", "-T", "/usr/bin/codesign"], "import .p12");
    runSecurity(["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", keychainPassword, keychain], "allow noninteractive signing");
    const pemList = runSecurity(["find-certificate", "-a", "-c", env.APPLE_SIGNING_IDENTITY, "-p", keychain], "read imported certificate");
    const certificate = signingCertificate(pemList, env.APPLE_SIGNING_IDENTITY, plan.environment.MACOS_SIGNING_CERT_SHA1, plan.mode);
    if (plan.mode === "self-signed") {
      writeFileSync(certificatePath, certificate.toString(), { mode: 0o600 });
      // Trust only this fixed certificate for code signing on the disposable
      // CI runner. This does not grant Gatekeeper trust on users' computers.
      runSecurity(["add-trusted-cert", "-d", "-r", "trustRoot", "-p", "codeSign", "-k", keychain, certificatePath], "trust self-signed code-signing certificate on CI");
    }
    const identities = runSecurity(["find-identity", "-v", "-p", "codesigning", keychain], "check signing private key and certificate");
    if (!identities.toUpperCase().includes(plan.environment.MACOS_SIGNING_CERT_SHA1)) {
      throw new Error("The imported certificate has no valid code-signing identity/private key.");
    }
    const currentKeychains = runSecurity(["list-keychains", "-d", "user"], "read keychain search list")
      .split("\n").map((line) => line.trim().replace(/^"|"$/g, "")).filter(Boolean);
    runSecurity(["list-keychains", "-d", "user", "-s", ...currentKeychains, keychain], "add signing keychain to search list");
    exportEnvironment(env, plan.environment);
  } finally {
    rmSync(p12Path, { force: true });
  }
}

export function cleanupMacosCertificate(env, runSecurity = security) {
  const workDir = env.MACOS_SIGNING_WORK_DIR;
  if (!workDir) return;
  // Cleanup only the directory allocated by this script under RUNNER_TEMP.
  const tempRoot = resolve(env.RUNNER_TEMP || tmpdir());
  if (!resolve(workDir).startsWith(`${tempRoot}/taomni-signing-`) || resolve(workDir).slice(tempRoot.length + 1).includes("/")) {
    throw new Error("Refusing to clean an unexpected signing directory.");
  }
  const certificatePath = join(workDir, "certificate.pem");
  let failure;
  try {
    if (existsSync(certificatePath)) runSecurity(["remove-trusted-cert", "-d", certificatePath], "remove CI certificate trust");
  } catch (error) {
    // macOS hosted runners can block in the trust-removal authorization UI
    // even under sudo. The public trust entry expires with this disposable
    // runner; deleting the private-key keychain/files below remains mandatory.
    // security() rejects trust mutations on persistent/self-hosted machines.
    if (env.GITHUB_ACTIONS === "true" && env.RUNNER_ENVIRONMENT === "github-hosted") {
      console.warn("::warning::Could not remove the temporary code-signing trust entry; it will be discarded with this GitHub-hosted runner. Private-key cleanup continues.");
    } else {
      failure = error;
    }
  } finally {
    try { runSecurity(["delete-keychain", join(workDir, "signing.keychain-db")], "delete signing keychain"); } catch (error) { failure ??= error; }
    rmSync(workDir, { recursive: true, force: true });
  }
  if (failure) throw failure;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === "--cleanup-macos") {
      cleanupMacosCertificate(process.env);
    } else {
      const plan = releaseSigningPlan(process.env);
      if (plan.mode && plan.mode !== "adhoc") {
        if (process.platform !== "darwin") throw new Error("macOS certificate import must run on macOS.");
        importMacosCertificate(process.env, plan);
      } else {
        exportEnvironment(process.env, plan.environment);
      }
      console.log(plan.mode ? `macOS signing: ${plan.mode}; Apple notarization: ${plan.notarize}.` : "Updater signing configuration checked.");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
