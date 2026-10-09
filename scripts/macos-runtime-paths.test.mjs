import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const names = ["libgssapi_krb5.2.2.dylib", "libkrb5.3.3.dylib", "libk5crypto.3.1.dylib", "libcom_err.3.0.dylib", "libkrb5support.1.1.dylib"];
function fixture(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), "taomni-krb5-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  for (const script of ["bundle-krb5-macos.sh", "verify-macos-runtime-paths.sh"]) {
    mkdirSync(join(root, "scripts"), { recursive: true });
    copyFileSync(fileURLToPath(new URL(script, import.meta.url)), join(root, "scripts", script));
  }
  const binary = join(root, "src-tauri/target/x86_64-apple-darwin/release/taomni");
  const deps = names.map((name) => `${prefix}/${name}`);
  const system = "/usr/lib/libSystem.B.dylib";
  put(binary, JSON.stringify({ deps: [...deps, system], rpath: true }));
  for (const name of names) put(join(root, "brew/lib", name), JSON.stringify({ deps: [...deps, system] }));
  const tool = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
if (name === "uname") { console.log("Darwin"); process.exit(); }
const file = args.at(-1);
const value = JSON.parse(fs.readFileSync(file, "utf8"));
if (name === "otool") {
  if (process.env.TEST_OTOOL_FAIL) process.exit(1);
  if (args[0] === "-l") console.log(value.rpath ? "path @executable_path/../Frameworks (offset 12)" : "");
  else console.log(file + ":\\n" + value.deps.map((dep) => "\\t" + dep + " (compatibility version 1.0.0, current version 1.0.0)").join("\\n"));
}
if (name === "install_name_tool") {
  // Git Bash translates /opt/... arguments for native Node on Windows.
  if (args[0] === "-change") value.deps = value.deps.map((dep) => dep === args[1] || (process.platform === "win32" && args[1].replaceAll("\\\\", "/").endsWith(dep)) ? args[2] : dep);
  fs.writeFileSync(file, JSON.stringify(value));
}
if (name === "codesign") {
  if (value.deps.some((dep) => !dep.startsWith("@rpath/") && !dep.startsWith("/usr/lib/"))) process.exit(1);
}
`;
  for (const name of ["uname", "otool", "install_name_tool", "codesign"]) {
    const path = join(root, "bin", name);
    put(path, tool); chmodSync(path, 0o755);
  }
  const env = { ...process.env, PATH: `${join(root, "bin")}${delimiter}${process.env.PATH}`, LIBGSSAPI_PREFIX: join(root, "brew").replaceAll("\\", "/"), TAURI_ENV_TARGET_TRIPLE: "x86_64-apple-darwin" };
  // Git Bash prepends its system tools on Windows. Export uname explicitly so
  // the production script exercises its macOS branch on this test host too.
  const run = (script, args, overrides = {}) => spawnSync("bash", ["-c", 'uname() { echo Darwin; }; export -f uname; exec bash "$@"', "runtime-test", join(root, "scripts", script), ...args], { env: { ...env, ...overrides }, encoding: "utf8" });
  const app = join(root, "Taomni.app");
  return { root, binary, app, run, package: () => {
    mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
    mkdirSync(join(app, "Contents/Frameworks"), { recursive: true });
    copyFileSync(binary, join(app, "Contents/MacOS/taomni"));
    for (const name of names) copyFileSync(join(root, "src-tauri/frameworks", name), join(app, "Contents/Frameworks", name));
  } };
}

for (const prefix of ["/opt/homebrew/opt/krb5/lib", "/usr/local/Cellar/krb5/1.22.2/lib", "@@HOMEBREW_PREFIX@@/opt/krb5/lib", "@@HOMEBREW_CELLAR@@/krb5/1.22.2/lib"]) {
  test(`relocates executable and every bundled dylib from ${prefix}`, (t) => {
    const f = fixture(t, prefix);
    const result = f.run("bundle-krb5-macos.sh", ["all"]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const expected = [...names.map((name) => `@rpath/${name}`), "/usr/lib/libSystem.B.dylib"];
    for (const file of [f.binary, ...names.map((name) => join(f.root, "src-tauri/frameworks", name))]) {
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).deps, expected);
    }
    f.package();
    const verification = f.run("verify-macos-runtime-paths.sh", [f.app]);
    assert.equal(verification.status, 0, verification.stderr + verification.stdout);
  });
}

test("runtime gate rejects bottle paths, missing dylibs and missing Frameworks rpath", (t) => {
  const f = fixture(t, "@@HOMEBREW_PREFIX@@/opt/krb5/lib");
  assert.equal(f.run("bundle-krb5-macos.sh", ["stage"]).status, 0);
  f.package();
  const old = f.run("verify-macos-runtime-paths.sh", [f.app]);
  assert.notEqual(old.status, 0);
  assert.match(old.stderr, /Unbundled runtime dependency.*@@HOMEBREW_PREFIX@@/);
  assert.equal(f.run("bundle-krb5-macos.sh", ["fixbin"]).status, 0);
  f.package();
  rmSync(join(f.app, "Contents/Frameworks", names[0]));
  assert.match(f.run("verify-macos-runtime-paths.sh", [f.app]).stderr, /Missing runtime dependency/);
  f.package();
  const file = join(f.app, "Contents/MacOS/taomni");
  const data = JSON.parse(readFileSync(file, "utf8"));
  data.rpath = false;
  writeFileSync(file, JSON.stringify(data));
  assert.match(f.run("verify-macos-runtime-paths.sh", [f.app]).stderr, /Missing bundled Frameworks rpath/);
});

test("failed dependency inspection stops bundling instead of silently skipping relocation", (t) => {
  const f = fixture(t, "@@HOMEBREW_PREFIX@@/opt/krb5/lib");
  assert.notEqual(f.run("bundle-krb5-macos.sh", ["fixbin"], { TEST_OTOOL_FAIL: "1" }).status, 0);
});
