import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./install-linux-release-deps.sh", import.meta.url));
const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "taomni release apt "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mock = join(root, "apt-mock.cjs");
  const trace = join(root, "trace.jsonl");
  writeFileSync(mock, `
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const option = (key) => args.find((arg) => arg.startsWith(key + "="))?.slice(key.length + 1);
const sources = fs.readFileSync(option("Dir::Etc::sourcelist"), "utf8");
const lists = option("Dir::State::lists");
const action = args.includes("update") ? "update" : "install";
assert.equal(option("Dir::Etc::sourceparts"), "-");
assert.equal(option("Acquire::Retries"), "3");
for (const protocol of ["http", "https"]) assert.equal(option("Acquire::" + protocol + "::Timeout"), "30");
if (action === "update") {
  assert.equal(option("APT::Update::Error-Mode"), "any");
  assert.deepEqual(fs.readdirSync(lists), []);
  fs.writeFileSync(path.join(lists, "fresh-index"), "official repository indexes");
} else {
  assert.equal(fs.readFileSync(path.join(lists, "fresh-index"), "utf8"), "official repository indexes");
}
fs.appendFileSync(process.env.TEST_APT_TRACE, JSON.stringify({ action, args, sources, lists }) + "\\n");
if (process.env.TEST_APT_FAILURE === action) process.exit(100);
`);
  return {
    run: (failure = "") => spawnSync("bash", ["-c", `
sudo() {
  case "$1" in
    apt-get) shift; "$TEST_APT_NODE" "$TEST_APT_MOCK" "$@" ;;
    rm) shift; command rm "$@" ;;
    *) return 2 ;;
  esac
}
export -f sudo
bash "$TEST_APT_SCRIPT"
`], {
      encoding: "utf8", timeout: 30000,
      env: {
        ...process.env,
        RUNNER_TEMP: root.replaceAll("\\", "/"),
        TEST_APT_NODE: process.execPath,
        TEST_APT_MOCK: mock, TEST_APT_TRACE: trace, TEST_APT_SCRIPT: script,
        TEST_APT_FAILURE: failure,
      },
    }),
    calls: () => readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse),
    assertCleaned: () => assert(!readdirSync(root).some((name) => name.startsWith("taomni-release-apt."))),
  };
}

test("release dependency installation uses fresh official Jammy indexes for both apt calls", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = f.calls();
  assert.deepEqual(calls.map((call) => call.action), ["update", "install"]);
  assert.equal(calls[0].lists, calls[1].lists);
  for (const call of calls) {
    const sources = call.sources.trim().split("\n");
    assert.equal(sources.length, 4);
    for (const [index, suite] of ["jammy", "jammy-updates", "jammy-backports", "jammy-security"].entries()) {
      const host = suite === "jammy-security" ? "security" : "archive";
      assert.equal(sources[index], `deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://${host}.ubuntu.com/ubuntu ${suite} main restricted universe multiverse`);
    }
  }
  const install = calls[1].args;
  assert.deepEqual(install.slice(install.indexOf("install")), [
    "install", "-y", "libwebkit2gtk-4.1-dev", "libappindicator3-dev", "librsvg2-dev",
    "patchelf", "libkrb5-dev", "nasm", "libasound2-dev", "libv4l-dev", "libpipewire-0.3-dev",
    "libclang-dev", "libdbus-1-dev", "libudev-dev", "meson", "ninja-build", "pkg-config",
  ]);
  f.assertCleaned();
});

for (const failure of ["update", "install"]) {
  test(`a failed apt ${failure} stops the build and cleans temporary indexes`, (t) => {
    const f = fixture(t);
    const result = f.run(failure);
    assert.ifError(result.error);
    assert.equal(result.status, 100, result.stdout + result.stderr);
    assert.deepEqual(f.calls().map((call) => call.action), failure === "update" ? ["update"] : ["update", "install"]);
    f.assertCleaned();
  });
}

test("release workflow runs dependency regressions before builders and bounds Linux setup time", () => {
  const plan = workflow.split("  plan:\n")[1].split("  build:\n")[0];
  assert(plan.includes("scripts/install-linux-release-deps.test.mjs"));
  const step = workflow.split("      - name: Install Linux bundle dependencies\n")[1].split("      - name:")[0];
  assert(step.includes("if: matrix.platform == 'ubuntu-22.04'"));
  assert(step.includes("timeout-minutes: 20"));
  assert(step.includes("run: bash scripts/install-linux-release-deps.sh"));
  assert(workflow.includes("- platform: ubuntu-22.04"));
});
