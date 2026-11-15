import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { modularBoundaryViolations } from "./modular-boundaries.mjs";

function fixture(t, manifest = "") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taomni-capture-boundary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const child of ["src/screenshot", "src/mfa", "src/mobile", "src/servers", "src/config",
    "crates/taomni-capture/src", "crates/taomni-file-uri/src", "crates/taomni-rdp-common/src"]) {
    fs.mkdirSync(path.join(root, "src-tauri", child), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "src-tauri/crates/taomni-capture/Cargo.toml"), manifest);
  for (const name of ["taomni-file-uri", "taomni-rdp-common"]) {
    fs.writeFileSync(path.join(root, "src-tauri/crates", name, "Cargo.toml"), "");
  }
  return root;
}

function write(root, name, text) {
  fs.writeFileSync(path.join(root, name), text);
}

test("core consumers may use the capture crate and only the explicit headless table exception", (t) => {
  const root = fixture(t);
  write(root, "src-tauri/src/mobile/headless.rs", "    crate::servers::db::init_server_tables(&db).map_err(|e| e.to_string())?;\n");
  write(root, "src-tauri/src/mfa/capture.rs", "use taomni_capture::still::LumaFrame;\n");
  assert.deepEqual(modularBoundaryViolations(root), []);
  write(root, "src-tauri/src/mobile/headless.rs", "use crate::servers::rdp;\n");
  assert.match(modularBoundaryViolations(root).join("\n"), /headless.rs:1/);
});

test("a nested screenshot consumer cannot silently reintroduce Servers coupling", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "src-tauri/src/screenshot/scroll"));
  write(root, "src-tauri/src/screenshot/scroll/input.rs", "    crate::servers::rdp::control_permission_granted()\n");
  assert.match(modularBoundaryViolations(root).join("\n"), /scroll\/input.rs:1/);
});

test("capture dependencies reject WebView aliases and Linux xcap while allowing desktop targets", (t) => {
  const root = fixture(t, `[dependencies]\nbridge = { package = "tauri-utils", version = "2" }\nxcap = "0.9"\n`);
  const errors = modularBoundaryViolations(root).join("\n");
  assert.match(errors, /tauri-utils/);
  assert.match(errors, /xcap must be limited/);
  write(root, "src-tauri/crates/taomni-capture/Cargo.toml", `[target.'cfg(target_os = "macos")'.dependencies]\nxcap = "0.9"\n[target.'cfg(windows)'.dependencies]\nxcap = "0.9"\n`);
  assert.deepEqual(modularBoundaryViolations(root), []);
});

test("the hosted Linux tree gate catches forbidden transitive dependencies", (t) => {
  const root = fixture(t);
  const tree = path.join(root, "linux-tree.txt");
  fs.writeFileSync(tree, "taomni-capture v0.1.0\n└── capture-adapter v1.0.0\n    └── xcap v0.9.6\n");
  assert.match(modularBoundaryViolations(root, { linuxTreeFile: tree }).join("\n"), /dependency tree contains xcap/);
  fs.writeFileSync(tree, "taomni-capture v0.1.0\n└── x11rb v0.13.2\n");
  assert.deepEqual(modularBoundaryViolations(root, { linuxTreeFile: tree }), []);
});

test("server and core path helpers cannot import client-owned RDP modules", (t) => {
  const root = fixture(t);
  write(root, "src-tauri/src/servers/clipboard.rs", "use taomni_rdp_common::cliprdr;\n// crate::rdp is intentionally absent\n");
  write(root, "src-tauri/src/config/paths.rs", "use taomni_file_uri::uri_list_to_paths;\n");
  assert.deepEqual(modularBoundaryViolations(root), []);
  write(root, "src-tauri/src/servers/clipboard.rs", "use crate::{\n logging,\n rdp::cliprdr,\n};\n");
  write(root, "src-tauri/src/config/paths.rs", "    crate::rdp::cliprdr::uri_list_to_paths(text)\n");
  const errors = modularBoundaryViolations(root).join("\n");
  assert.match(errors, /servers\/clipboard.rs/);
  assert.match(errors, /config\/paths.rs/);
});

test("shared RDP dependencies reject core aliases and URI dependency inflation", (t) => {
  const root = fixture(t);
  write(root, "src-tauri/crates/taomni-rdp-common/Cargo.toml", '[dependencies]\ncore = { path = "../.." }\nbridge = { package = "tauri-utils", version = "2" }\n');
  write(root, "src-tauri/crates/taomni-file-uri/Cargo.toml", '[dependencies]\nurl = "2"\n');
  const errors = modularBoundaryViolations(root).join("\n");
  assert.match(errors, /application\/plugin state/);
  assert.match(errors, /tauri-utils/);
  assert.match(errors, /zero runtime\/build dependencies/);
  write(root, "src-tauri/crates/taomni-rdp-common/Cargo.toml", '[dependencies]\ntaomni-file-uri = { path = "../taomni-file-uri" }\n');
  write(root, "src-tauri/crates/taomni-file-uri/Cargo.toml", '[dev-dependencies]\ntempfile = "3"\n');
  assert.deepEqual(modularBoundaryViolations(root), []);
});
