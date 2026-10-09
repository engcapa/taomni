import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "taomni-bundle-gate-unit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, "scripts", "verify-macos-release-bundle.sh");
  mkdirSync(dirname(script), { recursive: true });
  copyFileSync(fileURLToPath(new URL("./verify-macos-release-bundle.sh", import.meta.url)), script);
  copyFileSync(fileURLToPath(new URL("./verify-macos-runtime-paths.sh", import.meta.url)), join(root, "scripts/verify-macos-runtime-paths.sh"));
  const bundle = join(root, "src-tauri/target/x86_64-apple-darwin/release/bundle/macos");
  const app = join(bundle, "Taomni.app");
  const put = (path, bytes, executable = false) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    if (executable) chmodSync(path, 0o755);
  };
  put(join(app, "Contents/MacOS/taomni"), "#!/bin/sh\n# app executable\n", true);
  put(join(app, "Contents/Frameworks/libgssapi_krb5.2.2.dylib"), "bundled krb5");
  put(join(app, "Contents/Resources/sockscap/macos/xray"), "#!/bin/sh\n# xray executable\n", true);
  for (const name of ["Mitmproxy Redirector.app.tar", "manifest.json", "LICENSE"]) {
    const relative = `sockscap/macos/redirector/0.12.11/${name}`;
    put(join(root, "src-tauri/resources", relative), `pinned ${name}`);
    put(join(app, "Contents/Resources", relative), `pinned ${name}`);
  }
  const pack = () => execFileSync("tar", ["-czf", `${app}.tar.gz`, "-C", bundle, "Taomni.app"], { env: { ...process.env, LC_ALL: "C", LANG: "C" }, stdio: "ignore" });
  pack();
  put(`${app}.tar.gz.sig`, "fixture signature");

  // These mocks exercise the release gate's branches without installing
  // certificates, changing host trust or needing a full application build.
  const bin = join(root, "bin");
  const tool = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_TRACE, name + " " + args.join(" ") + "\\n");
if (name === "lipo") { console.log(process.env.TEST_WRONG_ARCH ? "arm64" : "x86_64"); }
if (name === "shasum") console.log(require("node:crypto").createHash("sha1").update(fs.readFileSync(args.at(-1))).digest("hex") + "  " + args.at(-1));
if (name === "otool") {
  if (args[0] === "-l") console.log("path @executable_path/../Frameworks (offset 12)");
  else console.log(args[1] + ":\\n\\t" + (process.env.TEST_BOTTLE_PATH ? "@@HOMEBREW_PREFIX@@/opt/krb5/lib/" : "@rpath/") + "libgssapi_krb5.2.2.dylib (compatibility version 2.0.0, current version 2.2.0)");
}
if (name === "codesign") {
  const updater = args.at(-1).includes("/updater/");
  if (args.includes("--verify") && process.env.TEST_INVALID_SIGNATURE) process.exit(1);
  if (args.includes("--verbose=4")) console.error("Identifier=com.taomni.app\\nTeamIdentifier=TEAM123456\\nflags=" + (process.env.MACOS_SIGNING_MODE === "developer-id" || process.env.TEST_HARDENED_RUNTIME ? "0x10000(runtime)" : "0x0(none)"));
  if (args.includes("--extract-certificates")) { console.error("certificate prefix was parsed as a filename"); process.exit(1); }
  const extract = args.find((arg) => arg.startsWith("--extract-certificates="));
  if (extract) fs.writeFileSync(extract.slice("--extract-certificates=".length) + "0", updater && process.env.TEST_DIFFERENT_CERTIFICATE ? "different certificate" : "fixed certificate");
  if (args.includes("-r-")) console.error('designated => identifier "com.taomni.app" and ' + (process.env.TEST_CDHASH ? 'cdhash H"binary-hash"' : 'anchor H"' + (updater && process.env.TEST_DIFFERENT_REQUIREMENT ? "changed-anchor" : "fixed-anchor") + '"'));
}
if (name === "spctl") console.error(process.env.TEST_UNNOTARIZED ? "source=Developer ID" : "source=Notarized Developer ID");
`;
  for (const name of ["lipo", "codesign", "spctl", "xcrun", "otool", "shasum"]) put(join(bin, name), tool, true);
  const trace = join(root, "trace");
  const env = {
    ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`,
    RUNNER_TEMP: root.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`),
    MACOS_SIGNING_MODE: "self-signed", MACOS_NOTARIZE: "false",
    MACOS_SIGNING_CERT_SHA1: createHash("sha1").update("fixed certificate").digest("hex").toUpperCase(),
    APPLE_TEAM_ID: "", RELEASE_TAG: "v0.4.30", TEST_TRACE: trace,
  };
  return {
    app, root, pack, trace,
    run: (overrides = {}) => spawnSync("bash", [script, "x86_64-apple-darwin", "x86_64"], { env: { ...env, ...overrides }, encoding: "utf8" }),
  };
}

test("self-signed release gate validates the app and archived updater against the same certificate and requirement", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const trace = readFileSync(f.trace, "utf8");
  assert.equal(trace.split("\n").filter((line) => line.startsWith("codesign --verify --deep --strict")).length, 2);
  assert(!trace.includes("spctl"));
});

for (const failure of ["TEST_INVALID_SIGNATURE", "TEST_DIFFERENT_CERTIFICATE", "TEST_CDHASH", "TEST_DIFFERENT_REQUIREMENT", "TEST_WRONG_ARCH", "TEST_HARDENED_RUNTIME", "TEST_BOTTLE_PATH"]) {
  test(`release gate rejects ${failure}`, (t) => {
    const f = fixture(t);
    assert.notEqual(f.run({ [failure]: "1" }).status, 0);
  });
}

test("release gate rejects a missing updater signature and different archived executable", (t) => {
  const f = fixture(t);
  rmSync(`${f.app}.tar.gz.sig`);
  assert.notEqual(f.run().status, 0);
  writeFileSync(`${f.app}.tar.gz.sig`, "fixture signature");
  writeFileSync(join(f.app, "Contents/MacOS/taomni"), "changed executable");
  assert.notEqual(f.run().status, 0);
});

test("notarization gates are independent from fixed signing and reject an unnotarized result", (t) => {
  const f = fixture(t);
  const env = { MACOS_SIGNING_MODE: "developer-id", APPLE_TEAM_ID: "TEAM123456" };
  assert.equal(f.run(env).status, 0);
  assert.equal(f.run({ ...env, MACOS_NOTARIZE: "true" }).status, 0);
  assert.notEqual(f.run({ ...env, MACOS_NOTARIZE: "true", TEST_UNNOTARIZED: "1" }).status, 0);
});

test("ad-hoc builds are only allowed for workflow artifacts", (t) => {
  const f = fixture(t);
  assert.notEqual(f.run({ MACOS_SIGNING_MODE: "adhoc" }).status, 0);
  const result = f.run({ MACOS_SIGNING_MODE: "adhoc", RELEASE_TAG: "" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("certificate-signed workflow artifacts can omit updater signatures when no updater key was configured", (t) => {
  const f = fixture(t);
  rmSync(`${f.app}.tar.gz.sig`);
  const result = f.run({ RELEASE_TAG: "", TAURI_SIGNING_PRIVATE_KEY: "" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.notEqual(f.run({ RELEASE_TAG: "", TAURI_SIGNING_PRIVATE_KEY: "configured-key" }).status, 0);
});
