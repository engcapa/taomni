import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const refresh = fileURLToPath(new URL("./refresh-sherpa-onnx-cache.mjs", import.meta.url));
const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

test("both release builders refresh sherpa native state after restoring Rust caches", () => {
  for (const job of ["build", "build-macos"]) {
    const body = workflow.split(`  ${job}:`)[1].split(/\n  [\w-]+:/)[0];
    const cache = body.indexOf("uses: swatinem/rust-cache@v2");
    const refresh = body.indexOf("run: node scripts/refresh-sherpa-onnx-cache.mjs");
    const firstBuild = body.search(/run:.*cargo|run:.*pnpm tauri|pwsh scripts\/stage-sockscap/);
    assert(cache >= 0 && refresh > cache, `${job}: refresh must follow cache restore`);
    assert(firstBuild < 0 || refresh < firstBuild, `${job}: refresh must precede native builds`);
  }
  const macos = workflow.split("  build-macos:")[1];
  assert(macos.includes("refresh-sherpa-onnx-cache.mjs src-tauri/Cargo.toml aarch64-apple-darwin x86_64-apple-darwin"));
  const gate = workflow.split("- name: Verify Windows installer runtimes")[1].split("- name: Collect workflow artifacts")[0];
  assert(gate.includes("TAOMNI_SHERPA_NATIVE_TEST: '1'"));
  assert(gate.includes("node --test scripts/sherpa-onnx-cache.test.mjs"));
});

// Opt in to real MSVC linking, using a locally available upstream archive.
// TAOMNI_SHERPA_TEST_ARCHIVE_DIR must contain the pinned shared tar.bz2.
const native = process.env.TAOMNI_SHERPA_NATIVE_TEST === "1";
for (const explicitTarget of [undefined, "x86_64-pc-windows-msvc"]) {
  test(`Windows debug/release cache recovery (${explicitTarget ?? "host"})`, {
    skip: !native,
    timeout: 300000,
  }, (t) => verifyNativeCacheRecovery(t, explicitTarget));
}

function verifyNativeCacheRecovery(t, explicitTarget) {
  assert.equal(process.platform, "win32", "This regression requires MSVC and Windows DLL loading");
  assert(process.env.TAOMNI_SHERPA_TEST_ARCHIVE_DIR, "Provide an offline sherpa archive directory");
  const root = mkdtempSync(join(tmpdir(), "taomni sherpa cache "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "custom target");
  const manifest = join(root, "Cargo.toml");
  const source = join(root, "src/main.rs");
  const output = (profile) => join(target, ...(explicitTarget ? [explicitTarget] : []), profile);
  const refreshArgs = [refresh, manifest, ...(explicitTarget ? [explicitTarget] : [])];
  mkdirSync(join(root, "src"));
  writeFileSync(manifest, `[package]
name = "sherpa-cache-probe"
version = "0.0.0"
edition = "2021"
[dependencies]
sherpa-onnx-sys = { version = "=1.13.8", default-features = false, features = ["shared"] }
`);
  writeFileSync(source, `fn main() {
    let version = unsafe { std::ffi::CStr::from_ptr(sherpa_onnx_sys::SherpaOnnxGetVersionStr()) };
    println!("{}", version.to_str().unwrap());
}
`);
  const env = {
    ...process.env,
    CARGO_TARGET_DIR: target,
    CARGO_INCREMENTAL: "0",
    CARGO_NET_OFFLINE: "true",
    SHERPA_ONNX_ARCHIVE_DIR: process.env.TAOMNI_SHERPA_TEST_ARCHIVE_DIR,
  };
  delete env.SHERPA_ONNX_LIB_DIR;
  delete env.DOCS_RS;
  function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", timeout: 240000 });
    assert.ifError(result.error);
    return result;
  }
  function successful(result) {
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const build = (profile = "debug") => run("cargo", [
    "build", "--offline", "--manifest-path", manifest,
    ...(profile === "release" ? ["--release"] : []),
    ...(explicitTarget ? ["--target", explicitTarget] : []),
  ]);
  successful(run(process.execPath, refreshArgs));
  successful(build());
  successful(build("release"));

  // Match rust-cache: preserve empty native directories and Cargo dependency
  // fingerprints, but drop native payloads and the profile-root runtime DLLs.
  const prebuilt = join(target, "sherpa-onnx-prebuilt");
  rmSync(prebuilt, { recursive: true });
  const lib = join(prebuilt, "sherpa-onnx-v1.13.8-win-x64-shared-MT-Release-lib/lib");
  mkdirSync(lib, { recursive: true });
  const dlls = ["sherpa-onnx-c-api.dll", "sherpa-onnx-cxx-api.dll", "onnxruntime.dll", "onnxruntime_providers_shared.dll"];
  for (const profile of ["debug", "release"]) {
    for (const dll of dlls) rmSync(join(output(profile), dll));
  }
  writeFileSync(source, readFileSync(source, "utf8") + "// Force the application to link against cached dependencies.\n");
  const broken = build();
  assert.notEqual(broken.status, 0, "The pruned-cache fixture must reproduce the release failure");
  assert.match(broken.stderr, /LNK1181.*sherpa-onnx-c-api\.lib/);
  t.diagnostic("Reproduced LNK1181 for sherpa-onnx-c-api.lib before refresh");

  successful(run(process.execPath, refreshArgs));
  assert(!existsSync(lib), "Empty lib directories must not suppress upstream extraction");
  successful(build());
  assert(existsSync(join(lib, "sherpa-onnx-c-api.lib")));
  // Match the release workflow: the debug helper repopulates shared import
  // libraries first. A stale release fingerprint can then link successfully
  // without restoring its DLLs, only failing later in the NSIS File macro.
  successful(build("release"));
  for (const dll of dlls) {
    assert(existsSync(join(output("release"), dll)), `Release runtime DLL was not restored: ${dll}`);
  }

  // Execute from a separate payload with only the rebuilt binary and DLLs;
  // the Cargo target layout must not conceal missing runtime dependencies.
  for (const profile of ["debug", "release"]) {
    const payload = join(root, `payload-${profile}`);
    mkdirSync(payload);
    for (const file of ["sherpa-cache-probe.exe", ...dlls]) {
      copyFileSync(join(output(profile), file), join(payload, file));
    }
    const loaded = run(join(payload, "sherpa-cache-probe.exe"), []);
    successful(loaded);
    assert.match(loaded.stdout, /1\.13\.8/);
  }
  t.diagnostic("Refreshed cache rebuilt import libraries and loaded isolated debug and release runtimes");
  if (process.env.TAOMNI_REQUIRE_NSIS_TESTS === "1") {
    verifyNsisRuntime(root, output("release"), run, successful);
    t.diagnostic("NSIS packaged the restored release DLLs; installed probe loaded sherpa successfully");
  }
}

function verifyNsisRuntime(root, release, run, successful) {
  const makensis = process.env.MAKENSIS ?? join(process.env.LOCALAPPDATA, "tauri/NSIS/makensis.exe");
  assert(existsSync(makensis), "Native NSIS tests require makensis");
  const hooks = fileURLToPath(new URL("../src-tauri/nsis/hooks.nsh", import.meta.url));
  const installer = join(root, "setup.exe");
  const installed = join(root, "installed");
  const script = join(root, "runtime.nsi");
  writeFileSync(script, `Unicode true
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
Name "Sherpa cache recovery regression"
OutFile "${installer}"
InstallDir "${installed}"
!define MAINBINARYNAME "sherpa-cache-probe"
!define MAINBINARYSRCPATH "${join(release, "sherpa-cache-probe.exe")}"
!include "${hooks}"
Section
  SetOutPath "$INSTDIR"
  File "\u0024{MAINBINARYSRCPATH}"
  !insertmacro NSIS_HOOK_POSTINSTALL
  WriteUninstaller "$INSTDIR\\uninstall.exe"
SectionEnd
Section "Uninstall"
  Delete "$INSTDIR\\sherpa-cache-probe.exe"
  Delete "$INSTDIR\\uninstall.exe"
  !insertmacro NSIS_HOOK_POSTUNINSTALL
SectionEnd
`);
  successful(run(makensis, ["/V2", script]));
  successful(run(installer, ["/S"]));
  const loaded = run(join(installed, "sherpa-cache-probe.exe"), []);
  successful(loaded);
  assert.match(loaded.stdout, /1\.13\.8/);
  const uninstalled = spawnSync(join(installed, "uninstall.exe"), ["/S", `_?=${installed}`], {
    timeout: 30000, windowsVerbatimArguments: true, encoding: "utf8",
  });
  assert.ifError(uninstalled.error);
  successful(uninstalled);
  assert(!existsSync(join(installed, "sherpa-onnx-c-api.dll")));
}
