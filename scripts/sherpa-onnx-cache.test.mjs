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
});

// Opt in to real MSVC linking, using a locally available upstream archive.
// TAOMNI_SHERPA_TEST_ARCHIVE_DIR must contain the pinned shared tar.bz2.
const native = process.env.TAOMNI_SHERPA_NATIVE_TEST === "1";
test("Windows links and loads sherpa again after a pruned warm cache", {
  skip: !native,
  timeout: 300000,
}, (t) => {
  assert.equal(process.platform, "win32", "This regression requires MSVC and Windows DLL loading");
  assert(process.env.TAOMNI_SHERPA_TEST_ARCHIVE_DIR, "Provide an offline sherpa archive directory");
  const root = mkdtempSync(join(tmpdir(), "taomni sherpa cache "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "custom target");
  const manifest = join(root, "Cargo.toml");
  const source = join(root, "src/main.rs");
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
  const build = () => run("cargo", ["build", "--offline", "--manifest-path", manifest]);
  successful(run(process.execPath, [refresh, manifest]));
  successful(build());

  // Match rust-cache: preserve empty native directories and Cargo dependency
  // fingerprints, but drop native payloads and the profile-root runtime DLLs.
  const prebuilt = join(target, "sherpa-onnx-prebuilt");
  rmSync(prebuilt, { recursive: true });
  const lib = join(prebuilt, "sherpa-onnx-v1.13.8-win-x64-shared-MT-Release-lib/lib");
  mkdirSync(lib, { recursive: true });
  const dlls = ["sherpa-onnx-c-api.dll", "sherpa-onnx-cxx-api.dll", "onnxruntime.dll", "onnxruntime_providers_shared.dll"];
  for (const dll of dlls) rmSync(join(target, "debug", dll));
  writeFileSync(source, readFileSync(source, "utf8") + "// Force the application to link against cached dependencies.\n");
  const broken = build();
  assert.notEqual(broken.status, 0, "The pruned-cache fixture must reproduce the release failure");
  assert.match(broken.stderr, /LNK1181.*sherpa-onnx-c-api\.lib/);
  t.diagnostic("Reproduced LNK1181 for sherpa-onnx-c-api.lib before refresh");

  successful(run(process.execPath, [refresh, manifest]));
  assert(!existsSync(lib), "Empty lib directories must not suppress upstream extraction");
  successful(build());
  assert(existsSync(join(lib, "sherpa-onnx-c-api.lib")));

  // Execute from a separate payload with only the rebuilt binary and DLLs;
  // the Cargo target layout must not conceal missing runtime dependencies.
  const payload = join(root, "payload");
  mkdirSync(payload);
  for (const file of ["sherpa-cache-probe.exe", ...dlls]) {
    copyFileSync(join(target, "debug", file), join(payload, file));
  }
  const loaded = run(join(payload, "sherpa-cache-probe.exe"), []);
  successful(loaded);
  assert.match(loaded.stdout, /1\.13\.8/);
  t.diagnostic("Refreshed cache rebuilt import libraries and loaded the isolated Windows runtime");
});
