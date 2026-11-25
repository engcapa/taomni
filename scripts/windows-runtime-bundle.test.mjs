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

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "taomni nsis runtime "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
!include "LogicLib.nsh"
!include "FileFunc.nsh"
Var UpdateMode
!include "${hooks}"
Section
  ClearErrors
  \${GetOptions} $CMDLINE "/UPDATE" $0
  \${IfNot} \${Errors}
    StrCpy $UpdateMode 1
  \${EndIf}
  !insertmacro NSIS_HOOK_POSTINSTALL
  ReadEnvStr $0 "TAOMNI_UPDATE_INSTALLER_PID"
  FileOpen $1 "${root}\\relaunch.txt" w
  FileWrite $1 "$0"
  FileClose $1
  WriteUninstaller "$INSTDIR\\uninstall.exe"
SectionEnd
Section "Uninstall"
  Delete "$INSTDIR\\uninstall.exe"
  !insertmacro NSIS_HOOK_POSTUNINSTALL
SectionEnd
`);
  return { root, destination, installer, compile: () => spawnSync(makensis, ["/V2", script], { encoding: "utf8" }) };
}

test("only a restarting update marks the installer child with its actual PID", { skip: !native }, (t) => {
  const f = fixture(t);
  mkdirSync(f.destination, { recursive: true });
  const compiled = f.compile();
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  for (const options of [[], ["/R"], ["/UPDATE"], ["/UPDATE", "/R"]]) {
    const run = spawnSync(f.installer, ["/S", ...options], { timeout: 30000 });
    assert.equal(run.status, 0, String(run.error));
    const marker = readFileSync(join(f.root, "relaunch.txt"), "utf8");
    assert.equal(marker, options.includes("/R") && options.includes("/UPDATE") ? String(run.pid) : "");
  }
});

test("Windows core setup cleans up the old Local Voice libraries", { skip: !native }, (t) => {
  const f = fixture(t);
  const result = f.compile();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  mkdirSync(f.destination, { recursive: true });
  for (const name of dlls) writeFileSync(join(f.destination, name), `old ${name}`);
  writeFileSync(join(f.destination, "user-file.txt"), "keep me");
  const install = spawnSync(f.installer, ["/S"], { timeout: 30000 });
  assert.equal(install.status, 0, String(install.error));
  for (const name of dlls) assert(!existsSync(join(f.destination, name)));
  assert.equal(readFileSync(join(f.destination, "user-file.txt"), "utf8"), "keep me");

  // Verify uninstall still clears a holdover from a previous installation.
  for (const name of dlls) writeFileSync(join(f.destination, name), `old ${name}`);
  const uninstall = spawnSync(join(f.destination, "uninstall.exe"), ["/S", `_?=${f.destination}`], { timeout: 30000, windowsVerbatimArguments: true });
  assert.equal(uninstall.status, 0, String(uninstall.error));
  for (const name of dlls) assert(!existsSync(join(f.destination, name)));
  assert.equal(readFileSync(join(f.destination, "user-file.txt"), "utf8"), "keep me");
});

test("release verifies both Windows installer payloads before artifact collection", () => {
  const workflow = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
  const build = workflow.indexOf("- name: Build desktop bundles");
  const gate = workflow.indexOf("- name: Verify Windows installer runtimes");
  const collect = workflow.indexOf("- name: Collect workflow artifacts");
  assert(build < gate && gate < collect);
  assert(workflow.slice(gate, collect).includes("scripts/verify-windows-release-bundle.ps1"));
  assert(workflow.slice(gate, collect).includes("scripts/windows-runtime-bundle.test.mjs"));
});
