# RDP Support Plan

## Context

NewMob already supports SSH/SFTP/Telnet and a hand-rolled VNC client with a
React canvas viewer. RDP is the next protocol on the list and the obvious
analog of VNC: a Rust-side proxy maintains the protocol session and exposes a
local WebSocket that an always-mounted React canvas tab consumes. This branch
adds first-class RDP with three connection modes — **direct TCP**, **HTTP/SOCKS5
proxy**, and **Microsoft RD Gateway (MS-TSGU)** — plus the three most
useful virtual channels (clipboard with cross-OS multi-file copy/paste, audio
playback, drive redirection).

`SessionType::RDP` (default port 3389), `TabKind = "rdp"`, and the RDP entry in
`SessionEditor`'s protocol list already exist; this branch fills in the actual
implementation behind them.

## Current Status (2026-05-28)

- Direct Windows RDP is wired through IronRDP 0.14 and has been live-verified
  against the current Win10 target (`192.168.35.128:3389`): CredSSP/NLA reaches
  `connected`, emits a first display frame (`1280x720` in the current test
  environment), and can resize to `1024x768`. The original
  black screen came from the old post-negotiation placeholder: the UI was told
  "connected", but the Rust worker was not yet driving IronRDP's active-stage
  graphics loop, so no framebuffer tiles were ever sent to the canvas.
- HTTP/SOCKS5 proxy mode reuses the existing terminal transport and shares the
  same IronRDP session path after the stream is opened.
- RD Gateway has protocol coverage in code for MS-RPCH RTS bootstrap, TsProxy
  NDR calls, Basic HTTP auth, and NTLM type1/type2/type3 HTTP auth. This path
  now also computes the NTLMv2 Type3 MIC from the Type1/Type2/Type3 messages,
  sends `TsProxyCloseChannel` + `TsProxyCloseTunnel` during shutdown, and
  cancels the OUT reader on drop. There is no real RD Gateway test
  environment available for this branch, so the current acceptance bar for
  RD Gateway is Rust unit coverage plus the ignored live smoke that can be run
  later when an environment exists.
- Dynamic Display Control is attached through `drdynvc` +
  `DisplayControlClient`, so resize requests use the real display-control
  channel when the server exposes it. If the channel is not available, the
  backend keeps the existing WebSocket/control session and reconnects the RDP
  transport at the requested desktop size; this is the path used by the current
  Win10 live target. The frontend sends normalized viewport dimensions instead
  of echoing the old connected size, debounces automatic viewer resize, and
  lets the toolbar button force a retry.
- Resize reactivation is handled: when Windows responds to a display-size
  change with `Server Deactivate All`, the session drives IronRDP's
  `ConnectionActivationSequence`, recreates the decoded image at the
  negotiated desktop size, emits a fresh `connected` event, and resumes normal
  graphics processing. The ignored live test covers both display-control
  reactivation and the reconnect fallback by asserting the post-resize
  `connected` dimensions.
- Mouse wheel input is wired end-to-end. The canvas sends a dedicated WS wheel
  control frame with coordinates, axis, and signed rotation units; the Rust
  session turns it into IronRDP `WheelRotations` fast-path input so scrolling
  works like a native Windows RDP client.
- RDP quick connect now opens `rdp://` URLs through the password prompt and
  into an RDP tab, using default port `3389` when no port is supplied.
- `RdpOptionsForm` is now mounted from `SessionEditor` for RDP sessions and the
  selected domain, color depth, NLA, performance, audio, clipboard, drive, and
  RD Gateway options are persisted into `options_json`. Serialization drops an
  empty RD Gateway block and strips gateway username/password when the gateway
  is configured to reuse the main RDP credentials.
- Latest verification: `cargo check --manifest-path src-tauri/Cargo.toml`
  passed; `cargo test --manifest-path src-tauri/Cargo.toml rdp:: --
  --nocapture` passed (`155` passed, `6` live tests ignored by default); and
  the serial live run against `192.168.35.128:3389` passed all five
  `rdp::session::tests::live_credssp*` tests (`connected`, first frame,
  clipboard, drive redirection, resize). The live clipboard proof reached
  CLIPRDR `clipboard-ready` and accepted a local Unicode text copy
  advertisement with `clipboard-local-copy`; it proves channel negotiation and
  local text publish through the active session, not a remote OS clipboard
  readback. The live drive proof maps a temp directory and waits for the
  Windows RDPDR device announce response, proving the server accepted the
  redirected drive channel (`drive-ready`).
  Frontend checks also passed: `.\node_modules\.bin\tsc.CMD -b` and
  `.\node_modules\.bin\vitest.CMD run src\lib\quickConnect.test.ts
  src\layouts\MainLayout.test.tsx src\components\session\SessionEditor.test.tsx
  src\lib\rdp.test.ts` (`64` tests; jsdom canvas warnings are expected in the
  existing suite).
- QA catalog coverage is now aligned with the implemented RDP feature:
  `qa-ui-auto-tests/feature-list.md` declares `F9.7` for the IronRDP-backed
  RDP client, `TC-111` covers the saved-session RDP panel/toolbar route in
  browser mode, and `.agents/skills/qa-ui-auto/references/testid-catalog.md`
  was regenerated. `qa_ui_auto.audit --feature F9.7` and
  `qa_ui_auto.gen_testid_catalog --check` both pass.
- The ignored live tests now cover both direct Windows CredSSP/display and an
  RD Gateway `open_tunnel` smoke when live environment variables are supplied.

## Architecture

Mirror the VNC architecture (`src-tauri/src/vnc/`) one-for-one. The high-level
flow is:

```
React <RdpPanel> ──ws──▶ Rust local-WS relay ──▶ IronRDP session ──▶ Transport
                                                                       │
                                                ┌──────────────────────┼──────────────────────┐
                                                ▼                      ▼                      ▼
                                          Direct TCP            HTTP/SOCKS5 proxy        RD Gateway
                                          (open_tcp_filtered)   (establish_transport)    (rpc_over_https)
```

Everything below the "Transport" row resolves to `AsyncRead + AsyncWrite`; the
RDP session does not know which path it took.

### Library choice — IronRDP (Devolutions)

- Crate: `ironrdp` umbrella (`ironrdp-connector`, `ironrdp-session`,
  `ironrdp-async`, `ironrdp-tokio`, `ironrdp-cliprdr`, `ironrdp-rdpdr`,
  `ironrdp-rdpsnd`).
- Use IronRDP 0.14.x, Apache-2.0/MIT, transport-agnostic, supports CredSSP
  (NLA), TLS, RemoteFX/graphics through `ironrdp-session`, and the three
  virtual channels we need.
- Pin exact versions in `src-tauri/Cargo.toml` and do not keep 0.8
  compatibility shims in this branch.

## Backend (`src-tauri/src/rdp/`)

Mirror `src-tauri/src/vnc/`:

| New file | Mirrors | Responsibility |
|---|---|---|
| `mod.rs` | `vnc/mod.rs` | Public Tauri commands: `rdp_connect`, `rdp_disconnect`, `rdp_test_connection`. |
| `ws.rs` | `vnc/ws.rs` | Bind a `127.0.0.1:0` listener, return `ws_port`, accept one WS upgrade, run the relay (3 tasks: WS→input, framebuffer→WS, control). |
| `session.rs` | `vnc/rfb.rs` | Drives `ironrdp-tokio::Framed` over the chosen transport; owns NLA/CredSSP, capability exchange, fast-path input, bitmap and surface decoding. |
| `frame.rs` | `vnc/encodings.rs` | Owns the stable RGBA tile wire format, color helpers, and tile slicing/validation; IronRDP active stage performs bitmap, RemoteFX, and surface decoding. |
| `transport.rs` | new | The `Transport` enum / async constructor that returns the unified `AsyncRead + AsyncWrite` (see Transport stack below). |
| `gateway.rs` | new | RD Gateway (MS-TSGU) RPC-over-HTTPS twin-channel transport. |
| `cliprdr.rs` | `vnc/clipboard.rs` | CLIPRDR including `CFSTR_FILEGROUPDESCRIPTORW` + `CFSTR_FILECONTENTS` for multi-file copy/paste. |
| `rdpsnd.rs` | new | RDPSND virtual channel; emits PCM frames as binary WS messages tagged `audio`. |
| `rdpdr.rs` | new | RDPDR drive redirection, maps one local folder → one remote drive letter. |

`AppState` (`src-tauri/src/state.rs`) gains:

```rust
pub rdp_sessions: Arc<RwLock<HashMap<String, RdpSession>>>,
```

`RdpSession` carries the same shape as `VncSession`: `control_tx`, `ws_port`,
`cancel`. Register the three commands in `src-tauri/src/lib.rs` next to the VNC
ones (`vnc::vnc_connect, …`).

### Transport stack (`rdp/transport.rs`)

One async constructor, three branches, returns
`Box<dyn AsyncRead + AsyncWrite + Unpin + Send>`:

```rust
match (network.proxy_kind.as_str(), options.gateway.as_ref()) {
    (_, Some(g)) => gateway::open_tunnel(g, host, port).await?,
    ("none", None) => terminal::network::open_tcp_filtered(host, port, ip_pref).await?,
    ("http"|"socks5", None) => terminal::network::establish_transport(host, port, Some(network)).await?,
    (other, _) => return Err(format!("proxy '{other}' not supported for RDP")),
}
```

Reuse:
- `src-tauri/src/terminal/network.rs::establish_transport` — already implements
  HTTP-CONNECT and SOCKS5 with auth; nothing else to write for proxy mode.
- `src-tauri/src/terminal/network.rs::open_tcp_filtered` for direct.

### RD Gateway (`rdp/gateway.rs`)

MS-TSGU is RPC-over-HTTPS with two parallel HTTPS channels (RPC_IN_DATA +
RPC_OUT_DATA) carrying TsProxy* RPC calls. Implementation:

1. **HTTPS transport** — open two `rustls`-backed TLS streams to
   `gateway:443`. Reuse the project's existing TLS strategy (already in the
   tree via `tokio-tungstenite`/`rustls`).
2. **HTTP authentication to the gateway** — Basic and Negotiate (NTLM v2).
   Add a small NTLM helper module under `gateway/ntlm.rs`; do not pull in a
   monolithic SSPI crate.
3. **TsProxy RPC sequence** (see [MS-TSGU §3.7]): `TsProxyCreateTunnel` →
   `TsProxyAuthorizeTunnel` → `TsProxyCreateChannel` →
   `TsProxySetupReceivePipe` (on OUT) + `TsProxySendToServer` (on IN). Encode
   PDUs by hand — DCE/RPC PDU framing is straightforward.
4. **Inner RDP CredSSP** — after `TsProxyCreateChannel`, the resulting
   `GatewayStream` is handed to the same IronRDP session path as direct TCP;
   NLA/CredSSP remains the target-server RDP authentication layer.
5. Wrap the tunnel in a `GatewayStream` type that implements
   `AsyncRead + AsyncWrite` by serializing reads/writes onto OUT/IN.
6. Cleanup: `TsProxyCloseChannel` + `TsProxyCloseTunnel` on drop / cancel.

Why hand-rolled: there is no maintained Rust crate for MS-TSGU. IronRDP's
transport-agnostic design is exactly the seam we need.

### Virtual channels

Clipboard, audio, and drive redirection plug into `ironrdp-session` via the
SVC/DVC abstraction. Display resize uses `drdynvc` +
`DisplayControlClient`. Server pointer changes are configured for IronRDP
software rendering (`pointer_software_rendering: true`), so cursor updates are
composited into graphics frames and do not need a separate frontend cursor
path right now.

**CLIPRDR with multi-file copy/paste** (`rdp/cliprdr.rs`)
- Caps negotiation: advertise `CB_USE_LONG_FORMAT_NAMES`,
  `CB_STREAM_FILECLIP_ENABLED`, `CB_FILECLIP_NO_FILE_PATHS`.
- Format list: `CF_UNICODETEXT`, `CFSTR_FILEGROUPDESCRIPTORW` (49158),
  `CFSTR_FILECONTENTS` (49159).
- Server→client (Windows → us): receive `Format List`, request
  `FILEGROUPDESCRIPTORW`, parse `FILEDESCRIPTORW` array, then issue
  `FILECONTENTS` requests (RANGE) and stream into a temp staging dir;
  surface to the host clipboard via `arboard` plus a platform-specific
  shim — on Linux/macOS we paste the staged paths as `text/uri-list`,
  on Windows we set the file-drop format. Use the existing `arboard`
  dependency; add `text/uri-list` handling under `rdp/cliprdr/uri_list.rs`.
- Client→server (us → Windows): when the host clipboard contains files,
  advertise the format and respond to remote `FILECONTENTS` requests with
  bytes streamed from disk.
- Reuse `arboard` (already a dep). Reuse the WS message envelope shape from
  `vnc::clipboard` for plumbing the metadata to the frontend (the frontend
  itself does not handle the file blobs; the OS clipboard does).

**RDPSND audio playback** (`rdp/rdpsnd.rs`)
- Negotiate PCM 44.1 kHz / 16-bit / stereo (the safe lowest common
  denominator) plus optionally one compressed format if IronRDP exposes a
  decoder out of the box.
- Receive `WaveInfo` + `Wave` PDUs, emit PCM frames as
  `WsOutgoing::Frame(audio_payload)` with a 1-byte channel tag (so
  `RdpPanel` can route audio vs. video).
- Frontend uses `AudioContext` + `AudioWorkletNode` to play.
- Send `WaveConfirm` PDUs back to keep the server's wave clock in sync.

**RDPDR drive redirection** (`rdp/rdpdr.rs`)
- Announce one device of type `RDPDR_DTYP_FILESYSTEM` named after a user-chosen
  local folder (configured in the RDP options).
- Implement the IO request handlers IronRDP exposes — Create, Read, Write,
  Close, Query{Information,Directory,Volume}, SetInformation, DeviceControl.
- Sandbox to a single mapped root (no path escapes; reject `..` after
  canonicalization).

## Frontend

### Tab plumbing (mirrors VNC exactly)

| New / changed file | Purpose |
|---|---|
| `src/components/rdp/RdpPanel.tsx` | New. Canvas viewer, WS client, input capture, scaling, audio worklet, status overlay. Sibling of `VncPanel.tsx`. |
| `src/components/rdp/RdpToolbar.tsx` | New. Reconnect / disconnect / fit / 1:1 / fullscreen / clipboard hint, mirrors VNC's. |
| `src/stores/rdpStore.ts` | New. Same shape as `vncStore.ts`: `Record<tabId, RdpConnectionState>`. |
| `src/lib/rdp.ts` | New. IPC wrappers (`rdpConnect`, `rdpDisconnect`, `rdpTestConnection`) and the binary WS message codec. |
| `src/lib/ipc.ts` | Add typed wrappers for the three new commands. |
| `src/types/index.ts` | Add `RdpConnectInfo` next to `VncConnectInfo`; `Tab` gets an optional `rdp?: RdpConnectInfo`. |
| `src/layouts/MainLayout.tsx` | Open RDP tab in `handleConnect` (model on the existing VNC branch around `MainLayout.tsx:477`); always-mount RDP panels (mirror the `vncTabs.map(...)` block around `MainLayout.tsx:1417`). |

WS framing reuses the VNC pattern from `src/lib/vnc.ts`: a 1-byte channel tag
selects between `frame` (RDP bitmap), `audio` (PCM), `cursor`, `clipboard`,
`status`. Helpers `encodeWsKey/Pointer/Resize/Wheel/ClipboardOffer` are
renamed + extended for RDP scancodes and pointer wheel units (RDP uses
scancodes; VNC uses keysyms).

### Session config (`options_json` for RDP)

Persist these under `SessionConfig.options_json` (the column already exists,
no migration needed):

```jsonc
{
  "domain": "CORP",
  "color_depth": 32,
  "screen_w": 1920, "screen_h": 1080,
  "nla": true,
  "performance": { "wallpaper": false, "themes": false, "font_smooth": true },
  "redirect_clipboard": true,
  "redirect_audio": "play",          // "play" | "off"
  "redirect_drive": { "enabled": false, "label": "shared", "path": "" },
  "gateway": {                        // optional; when present, overrides direct/proxy path
    "host": "rdg.example.com",
    "port": 443,
    "username": "user@CORP",
    "password": null,                 // or stored via auth_method secret
    "auth": "ntlm",                   // "basic" | "ntlm"
    "use_session_creds": true
  }
}
```

The TypeScript mirror lives in `src/types/rdp.ts` and `RdpOptionsForm` lives in
`src/components/session/forms/RdpOptionsForm.tsx`. `SessionEditor.tsx` renders
the form when the selected protocol is RDP and persists the normalized options
into the existing `options_json` column. Reuse the existing `NetworkSettings`
proxy editor unchanged for HTTP/SOCKS5; the gateway section is RDP-specific and
lives only in `RdpOptionsForm`.

### i18n

Strings go through the existing i18n framework — register new keys under
`rdp.*` in the locales used by the codebase, matching how the latest
`v0.1.32 i18n sweep` (last commit on `qa-ui-auto/...`) handled new strings.

## Cargo dependencies (new)

In `src-tauri/Cargo.toml`, add exact IronRDP 0.14-compatible versions:

```toml
ironrdp = { version = "0.14.0", features = ["connector", "session", "graphics", "input", "cliprdr", "rdpdr", "rdpsnd", "svc", "dvc", "displaycontrol"] }
ironrdp-tls = { version = "0.2.0", features = ["rustls"] }
ironrdp-tokio = { version = "0.8.0", features = ["reqwest-rustls-ring"] }
rustls = { version = "0.23", default-features = false, features = ["ring", "std"] }
```

`tokio-tungstenite`, `aes`, `sha2`, `arboard`, `rand` are already in the tree
and reused as-is.

## Dev/browser mode

RDP is desktop-only. Add a stub `vite-plugins/rdpProxy.ts` that returns
`501 not implemented` for the WS endpoint — keeps `pnpm dev` runnable without
crashing the dev server when an `rdp:` tab tries to open. Also add an
`@tauri-apps/*` stub equivalent in `src/stubs/` returning a clear "RDP not
available in browser mode" error.

## Implementation order

1. `rdp/mod.rs` skeleton + `rdp/ws.rs` + `rdp/transport.rs` (direct only) + IPC
   plumbing + minimal `RdpPanel` that paints a blank canvas on `connected`.
2. IronRDP wired up — display + keyboard/mouse only, NLA/CredSSP, autodetect
   bitmap & RDP 6.0 codecs.
3. Proxy mode: route through `establish_transport`. Smoke through
   `qa-ui-auto`.
4. CLIPRDR: text first, then `CFSTR_FILEGROUPDESCRIPTORW` + `CFSTR_FILECONTENTS`
   (Windows ↔ Linux ↔ macOS). Add the `text/uri-list` shim for non-Windows.
5. RDPSND with PCM + Web Audio worklet.
6. RDPDR with one mapped folder.
7. RD Gateway (`gateway.rs` + `gateway/ntlm.rs`); biggest single piece.
8. RemoteFX (RFX) decoder enabled.
9. Polish: reconnect, status overlay, perf flags surface, error toasts,
   fullscreen.

Each step is independently testable; CI / `pnpm exec tsc -b --noEmit` + cargo
build run after each.

## Critical files to be created or modified

Created:
- `src-tauri/src/rdp/{mod,ws,session,frame,transport,gateway,cliprdr,rdpsnd,rdpdr}.rs`
- `src-tauri/src/rdp/gateway/ntlm.rs`
- `src/components/rdp/{RdpPanel,RdpToolbar}.tsx`
- `src/components/session/forms/RdpOptionsForm.tsx`
- `src/stores/rdpStore.ts`
- `src/lib/rdp.ts`
- `src/types/rdp.ts`
- `vite-plugins/rdpProxy.ts`
- Tests: `src/lib/rdp.test.ts`, plus rust unit tests inline in `gateway.rs`
  (RPC PDU encode/decode round-trip) and `cliprdr.rs` (file-descriptor
  parser). One `qa-ui-auto` testcase: connect to a local FreeRDP test server
  (xrdp in CI container) and assert canvas paints + clipboard round-trip.

Modified:
- `src-tauri/src/state.rs` — add `rdp_sessions` field.
- `src-tauri/src/lib.rs` — register the three commands; spawn no autostart.
- `src-tauri/Cargo.toml` — add IronRDP crates.
- `src-tauri/src/session/models.rs` — no schema change; document the new
  `options_json` shape in a comment near `SessionType::RDP`.
- `src/lib/ipc.ts` — typed wrappers.
- `src/types/index.ts` — `RdpConnectInfo` + `Tab.rdp?`.
- `src/layouts/MainLayout.tsx` — RDP open + always-mount block, mirror VNC.
- `src/components/session/SessionEditor.tsx` — show `RdpOptionsForm` when
  protocol is RDP.
- `src/stubs/` — add Tauri-IPC stub for browser mode.
- `vite.config.ts` — register `rdpProxy` plugin in dev mode.
- Locale files — `rdp.*` keys.

## Verification

After each implementation step:

```bash
pnpm install                    # if deps changed
pnpm exec tsc -b --noEmit       # frontend type check
cargo check --manifest-path src-tauri/Cargo.toml
pnpm test src/lib/rdp.test.ts   # unit
cargo test -p newmob rdp::      # rust unit tests for RPC + CLIPRDR codecs
pnpm tauri dev                  # manual: open an RDP tab, check canvas
```

End-to-end matrix to run before merge:

| Mode | Target | Auth | Channels |
|---|---|---|---|
| Direct | xrdp on Linux VM | password | display + clipboard text |
| Direct | Windows 11 host | NLA | + audio + drive redir |
| Direct | Windows 11 host | NLA | + multi-file clipboard (Win→Linux + Linux→Win) |
| HTTP-CONNECT proxy | Win11 via squid | NLA | display |
| SOCKS5 proxy | Win11 via dante | NLA | display |
| RD Gateway | Win Server gateway → Win11 | NLA + Basic gateway auth | display; run when an RDG environment exists |
| RD Gateway | Win Server gateway → Win11 | NLA + NTLM gateway auth | display + clipboard; run when an RDG environment exists |

`qa-ui-auto` smoke: at minimum a "RDP tab opens and canvas reaches `connected`
state against a local xrdp container." Add this to
`qa-ui-auto-tests/testcases/`.
