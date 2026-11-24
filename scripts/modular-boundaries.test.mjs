import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { modularBoundaryViolations } from "./modular-boundaries.mjs";

function fixture(t, manifest = "") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taomni-capture-boundary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shared = ["taomni-asr-models", "taomni-local-voice-api", "taomni-file-uri", "taomni-rdp-common", "taomni-rdp-client-api",
    "taomni-rdp-client-engine", "taomni-mail-api", "taomni-mail-engine", "taomni-mfa-engine", "taomni-vnc-api",
    "taomni-vnc-engine", "taomni-vnc-key-protocol", "taomni-redirector", "taomni-screenshot-api",
    "taomni-screenshot-ocr", "taomni-screenshot-recording", "taomni-server-process", "taomni-local-servers-engine", "taomni-pty"];
  for (const child of ["src/screenshot", "src/mfa", "src/mobile", "src/servers", "src/config",
    "crates/taomni-capture/src", ...shared.map(name => `crates/${name}/src`)]) {
    fs.mkdirSync(path.join(root, "src-tauri", child), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "src-tauri/crates/taomni-capture/Cargo.toml"), manifest);
  for (const name of shared) {
    fs.writeFileSync(path.join(root, "src-tauri/crates", name, "Cargo.toml"), "");
  }
  return root;
}

function write(root, name, text) {
  fs.writeFileSync(path.join(root, name), text);
}

test("core consumers use shared capture and headless cannot initialize server tables", (t) => {
  const root = fixture(t);
  write(root, "src-tauri/src/mobile/headless.rs", "    crate::servers::db::init_server_tables(&db).map_err(|e| e.to_string())?;\n");
  write(root, "src-tauri/src/mfa/capture.rs", "use taomni_capture::still::LumaFrame;\n");
  assert.match(modularBoundaryViolations(root).join("\n"), /headless.rs:1/);
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

test("core state rejects feature owners and implicit composition forwarding", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "src-tauri/src/state"));
  write(root, "src-tauri/src/state.rs", "pub struct AppState { core: Arc<CoreState>, legacy: LegacyFeatureRuntime }\n");
  write(root, "src-tauri/src/state/core.rs", "pub struct CoreState { db: Mutex<Connection> }\n");
  write(root, "src-tauri/src/state/domains.rs", "pub struct TerminalRuntime {}\n");
  assert.deepEqual(modularBoundaryViolations(root), []);
  write(root, "src-tauri/src/state/core.rs", "use crate::mfa::store::MfaStore;\npub struct CoreState { mfa: Arc<MfaStore> }\n");
  write(root, "src-tauri/src/state.rs", "impl std::ops::Deref for AppState { }\n");
  const errors = modularBoundaryViolations(root).join("\n");
  assert.match(errors, /cannot own optional feature/);
  assert.match(errors, /must not use Deref/);
});

test("MFA engine rejects runtime dependencies, core paths and application services", (t) => {
  const root = fixture(t);
  write(root, "src-tauri/crates/taomni-mfa-engine/Cargo.toml", '[dependencies]\nbridge = { package = "tauri-utils", version = "2" }\ncore = { path = "../.." }\n');
  write(root, "src-tauri/crates/taomni-mfa-engine/src/keys.rs", "use crate::vault::Vault;\n");
  const errors = modularBoundaryViolations(root).join("\n");
  assert.match(errors, /tauri-utils/);
  assert.match(errors, /core links runtime/);
  assert.match(errors, /keys.rs: MFA engine must not import application services/);
  write(root, "src-tauri/crates/taomni-mfa-engine/Cargo.toml", '[dependencies]\nrusqlite = "0.40"\n');
  write(root, "src-tauri/crates/taomni-mfa-engine/src/keys.rs", "use crate::crypto::DataKey;\n");
  assert.deepEqual(modularBoundaryViolations(root), []);
});

test("Mail engine rejects dependencies on the desktop and host runtime", (t) => {
  const root = fixture(t);
  const manifest = "src-tauri/crates/taomni-mail-engine/Cargo.toml";
  write(root, manifest, '[dependencies]\nmail-parser = "0.11"\n');
  assert.deepEqual(modularBoundaryViolations(root), []);
  write(root, manifest, '[dependencies]\ncore = { path = "../.." }\n');
  write(root, "src-tauri/crates/taomni-mail-engine/src/lib.rs", "use taomni_plugin_sdk::HostSession;\n");
  const errors = modularBoundaryViolations(root).join("\n");
  assert.match(errors, /taomni-mail-engine\/Cargo.toml.*core links application\/plugin state/);
  assert.match(errors, /lib.rs: shared library must not import application\/plugin state/);
});

test("Mail protocol types allow the routed transport and exclude the engine", (t) => {
  const root = fixture(t);
  const api = "src-tauri/crates/taomni-mail-api";
  const manifest = '[dependencies]\ntaomni-plugin-stream = { path = "../taomni-plugin-stream" }\n';
  write(root, `${api}/Cargo.toml`, manifest);
  write(root, `${api}/src/lib.rs`, "use taomni_plugin_stream::routed_tcp::Endpoint;\nconst MAX: usize = taomni_plugin_stream::MAX_PAYLOAD_BYTES;\n");
  assert.deepEqual(modularBoundaryViolations(root), []);
  write(root, `${api}/Cargo.toml`, `${manifest}engine = { package = "taomni-mail-engine", path = "../taomni-mail-engine" }\n`);
  assert.match(modularBoundaryViolations(root).join("\n"), /taomni-mail-api.*engine links the Mail engine/);
});

test("Screenshot codecs stay independent of the desktop and the signed host", (t) => {
  const root = fixture(t);
  const api = "src-tauri/crates/taomni-screenshot-api";
  const codec = "src-tauri/crates/taomni-screenshot-recording";
  write(root, `${api}/Cargo.toml`, '[dependencies]\ntaomni-plugin-stream = { path = "../taomni-plugin-stream" }\n');
  write(root, `${api}/src/lib.rs`, "use taomni_plugin_stream::routed_tcp::Endpoint;\n");
  assert.deepEqual(modularBoundaryViolations(root), []);
  write(root, `${codec}/Cargo.toml`, '[dependencies]\napp = { path = "../.." }\n');
  write(root, `${codec}/src/lib.rs`, "use taomni_plugin_sdk::Operation;\n");
  const errors = modularBoundaryViolations(root).join("\n");
  assert.match(errors, /taomni-screenshot-recording\/Cargo.toml.*app links application\/plugin state/);
  assert.match(errors, /taomni-screenshot-recording.*shared library must not import application\/plugin state/);
});

test("MFA host requires SDK services and rejects transitive application ownership", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "src-tauri/plugins/mfa/src"), { recursive: true });
  write(root, "src-tauri/plugins/mfa/Cargo.toml", '[dependencies]\nbridge = { package = "tauri-utils", version = "2" }\ncore = { path = "../.." }\n');
  write(root, "src-tauri/plugins/mfa/src/keys.rs", "use taomni_plugin_services::OperationPermit;\n");
  const errors = modularBoundaryViolations(root).join("\n");
  assert.match(errors, /MFA host alias links core-owned package tauri-utils/);
  assert.match(errors, /core links core-owned services/);
  assert.match(errors, /MFA host must access core services only through the SDK/);
  write(root, "src-tauri/plugins/mfa/Cargo.toml", '[dependencies]\ntaomni-plugin-sdk = { path = "../../crates/taomni-plugin-sdk" }\n');
  write(root, "src-tauri/plugins/mfa/src/keys.rs", "use taomni_plugin_sdk::Operation;\n");
  const tree = path.join(root, "mfa-host-tree.txt");
  fs.writeFileSync(tree, "taomni-plugin-mfa v0.1.0\ntaomni-plugin-sdk v0.1.0\n");
  assert.deepEqual(modularBoundaryViolations(root, { mfaHostTreeFile: tree }), []);
  fs.appendFileSync(tree, "taomni v0.3.0\n");
  assert.match(modularBoundaryViolations(root, { mfaHostTreeFile: tree }).join("\n"), /MFA host dependency tree contains taomni/);
});

test("MFA runtime cargo tree rejects transitive core/SDK and network ownership", (t) => {
  const root = fixture(t);
  const tree = path.join(root, "mfa-tree.txt");
  fs.writeFileSync(tree, "taomni-mfa-engine v0.1.0\nwrapper v1.0.0\ntaomni-plugin-sdk v0.1.0\nreqwest v0.13.0\n");
  const errors = modularBoundaryViolations(root, { mfaTreeFile: tree }).join("\n");
  assert.match(errors, /tree contains taomni-plugin-sdk/);
  assert.match(errors, /tree contains reqwest/);
  fs.writeFileSync(tree, "taomni-mfa-engine v0.1.0\nrusqlite v0.40.0\n");
  assert.deepEqual(modularBoundaryViolations(root, { mfaTreeFile: tree }), []);
  fs.writeFileSync(tree, "wrong-root v0.1.0\n");
  assert.match(modularBoundaryViolations(root, { mfaTreeFile: tree }).join("\n"), /does not identify/);
});

test("Mail host may use the engine and SDK without linking a peer module", (t) => {
  const root = fixture(t);
  const directory = "src-tauri/plugins/mail";
  fs.mkdirSync(path.join(root, directory, "src"), { recursive: true });
  write(root, `${directory}/Cargo.toml`, '[dependencies]\ntaomni-mail-engine = { path = "../../crates/taomni-mail-engine" }\n');
  const tree = path.join(root, "mail-host-tree.txt");
  fs.writeFileSync(tree, "taomni-plugin-mail v0.1.0\ntaomni-mail-engine v0.1.0\ntaomni-plugin-sdk v0.1.0\n");
  assert.deepEqual(modularBoundaryViolations(root, { mailHostTreeFile: tree }), []);
  fs.appendFileSync(tree, "taomni-plugin-mfa v0.1.0\n");
  assert.match(modularBoundaryViolations(root, { mailHostTreeFile: tree }).join("\n"), /Mail host dependency tree contains taomni-plugin-mfa/);
});

test("RDP client, VNC client, and SocksCap hosts enforce SDK-only ownership", (t) => {
  const root = fixture(t);
  for (const [slug, label, crate] of [
    ["rdp-client", "RDP Client", "taomni-rdp-client-engine"],
    ["vnc-client", "VNC Client", "taomni-vnc-engine"],
    ["sockscap", "SocksCap", "taomni-sockscap-api"],
  ]) {
    const directory = `src-tauri/plugins/${slug}`;
    fs.mkdirSync(path.join(root, directory, "src"), { recursive: true });
    write(root, `${directory}/Cargo.toml`, `[dependencies]\n${crate} = { path = "../../crates/${crate}" }\ntaomni-plugin-sdk = { path = "../../crates/taomni-plugin-sdk" }\n`);
    write(root, `${directory}/src/main.rs`, "use taomni_plugin_sdk::Operation;\n");
    assert.deepEqual(modularBoundaryViolations(root), []);
    write(root, `${directory}/Cargo.toml`, '[dependencies]\ncore = { path = "../.." }\n');
    write(root, `${directory}/src/main.rs`, "use crate::state::AppState;\n");
    const errors = modularBoundaryViolations(root).join("\n");
    assert.match(errors, new RegExp(`${label} host.*links core-owned services`));
    assert.match(errors, new RegExp(`${label} host must access core services only through the SDK`));
    fs.rmSync(path.join(root, directory), { recursive: true, force: true });
  }
});
