import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const hooks = fileURLToPath(new URL("../src-tauri/nsis/hooks.nsh", import.meta.url));
const makensis = process.env.MAKENSIS ?? (process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "tauri/NSIS/makensis.exe"));
const dlls = ["sherpa-onnx-c-api.dll", "sherpa-onnx-cxx-api.dll", "onnxruntime.dll", "onnxruntime_providers_shared.dll"];
const native = process.platform === "win32" && makensis && existsSync(makensis);
if (process.env.TAOMNI_REQUIRE_NSIS_TESTS === "1" && !native) throw new Error("Native NSIS tests require makensis on Windows");

function fixture(t, missing, forwardSlashes = false) {
  const root = mkdtempSync(join(tmpdir(), "taomni nsis runtime "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, "custom target/x86_64-pc-windows-msvc/debug/taomni.exe");
  mkdirSync(dirname(binary), { recursive: true });
  writeFileSync(binary, "fixture executable");
  for (const name of dlls) if (name !== missing) writeFileSync(join(dirname(binary), name), `new ${name}`);
  const destination = join(root, "install");
  const installer = join(root, "setup.exe");
  const script = join(root, "test.nsi");
  writeFileSync(script, `Unicode true
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
Name "Taomni runtime hook test"
OutFile "${installer}"
InstallDir "${destination}"
!define MAINBINARYNAME "taomni"
!define MAINBINARYSRCPATH "${forwardSlashes ? binary.replaceAll("\\", "/") : binary}"
!include "${hooks}"
Section
  !insertmacro NSIS_HOOK_POSTINSTALL
  WriteUninstaller "$INSTDIR\\uninstall.exe"
SectionEnd
Section "Uninstall"
  Delete "$INSTDIR\\uninstall.exe"
  !insertmacro NSIS_HOOK_POSTUNINSTALL
SectionEnd
`);
  return { root, destination, installer, compile: () => spawnSync(makensis, ["/V2", script], { encoding: "utf8" }) };
}

for (const forwardSlashes of [false, true]) {
  test(`real NSIS installs and overwrites all runtime DLLs (forward slashes: ${forwardSlashes})`, { skip: !native }, (t) => {
    const f = fixture(t, undefined, forwardSlashes);
    const result = f.compile();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const upgrade of [false, true]) {
      if (upgrade) for (const name of dlls) writeFileSync(join(f.destination, name), `old ${name}`);
      const install = spawnSync(f.installer, ["/S"], { timeout: 30000 });
      assert.equal(install.status, 0, String(install.error));
      for (const name of dlls) assert.equal(readFileSync(join(f.destination, name), "utf8"), `new ${name}`);
    }
    writeFileSync(join(f.destination, "user-file.txt"), "keep me");
    // NSIS requires _?= to be the unquoted remainder of the command line.
    const uninstall = spawnSync(join(f.destination, "uninstall.exe"), ["/S", `_?=${f.destination}`], { timeout: 30000, windowsVerbatimArguments: true });
    assert.equal(uninstall.status, 0, String(uninstall.error));
    for (const name of dlls) assert(!existsSync(join(f.destination, name)));
    assert.equal(readFileSync(join(f.destination, "user-file.txt"), "utf8"), "keep me");
  });
}

for (const missing of dlls) {
  test(`NSIS compilation rejects missing ${missing}`, { skip: !native }, (t) => {
    const f = fixture(t, missing);
    const result = f.compile();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, new RegExp(missing.replaceAll(".", "\\.")));
    assert(!existsSync(f.installer));
  });
}

test("release verifies both Windows installer payloads before artifact collection", () => {
  const workflow = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
  const build = workflow.indexOf("- name: Build desktop bundles");
  const gate = workflow.indexOf("- name: Verify Windows installer runtimes");
  const collect = workflow.indexOf("- name: Collect workflow artifacts");
  assert(build < gate && gate < collect);
  assert(workflow.slice(gate, collect).includes("scripts/verify-windows-release-bundle.ps1"));
  assert(workflow.slice(gate, collect).includes("scripts/windows-runtime-bundle.test.mjs"));
});
