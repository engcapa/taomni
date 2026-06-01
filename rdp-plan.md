# RDP Support Plan

> **Document status.** This file started life as the initial design plan. The
> implementation diverged from that plan in two important ways during
> development, and the sections below have been calibrated to match the code
> that actually shipped:
>
> 1. **IronRDP was upgraded 0.8 → 0.14.** The original plan pinned 0.8-era
>    crates; the branch now targets the IronRDP 0.14 family.
> 2. **The RDP protocol stack is delegated to IronRDP, not hand-rolled.** The
>    early plan described a VNC-style hand-written protocol layer
>    (`session.rs` mirroring `vnc/rfb.rs`, hand-coded CLIPRDR/RDPSND/RFX PDUs,
>    hand-rolled X.224/MCS). In the shipped code, IronRDP's
>    connector/session/virtual-channel backends own all of that. Several
>    hand-written modules from the original route survive in the tree as
>    framing/codec helpers with round-trip unit tests but are **not on the
>    live connection path** — they are called out explicitly below.
>
> The RD Gateway (MS-TSGU) transport is the one piece that remains
> hand-rolled, because no maintained Rust crate covers it; IronRDP's
> transport-agnostic design is the seam that lets it plug in.

## Context

Taomni already supports SSH/SFTP/Telnet and a hand-rolled VNC client with a
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

The flow mirrors the VNC architecture (`src-tauri/src/vnc/`):

```
React <RdpPanel> ──ws──▶ Rust local-WS relay ──▶ IronRDP session ──▶ Transport
                                                                       │
                                                ┌──────────────────────┼──────────────────────┐
                                                ▼                      ▼                      ▼
                                          Direct TCP            HTTP/SOCKS5 proxy        RD Gateway
                                          (establish_transport, (establish_transport)   (gateway::open_tunnel,
                                           proxy off)                                    RPC-over-HTTPS)
```

Everything below the "Transport" row resolves to `AsyncRead + AsyncWrite`; the
IronRDP session does not know which path it took.

### Library choice — IronRDP (Devolutions)

- Crate: `ironrdp` umbrella (`ironrdp-connector`, `ironrdp-session`,
  `ironrdp-async`, `ironrdp-tokio`, `ironrdp-cliprdr`, `ironrdp-rdpdr`,
  `ironrdp-rdpsnd`).
- **Shipped on IronRDP 0.14.x** (upgraded from the 0.8.x the plan originally
  pinned). Apache-2.0/MIT, transport-agnostic, supports CredSSP (NLA), TLS,
  RemoteFX/graphics through `ironrdp-session`, and the three virtual channels
  we need. The active-stage loop (`ActiveStage`), CredSSP/NLA, MCS, capability
  exchange, bitmap/RemoteFX/surface decoding, and fast-path input are all
  IronRDP's; `session.rs` drives that loop rather than re-implementing it.
- Versions are pinned exactly in `src-tauri/Cargo.toml`; no 0.8 compatibility
  shims remain.

## Backend (`src-tauri/src/rdp/`)

The actual module layout (which differs from the original plan — the
hand-rolled protocol modules listed at the bottom survive only as
framing/codec helpers + tests):

**On the live connection path:**

| File | Responsibility |
|---|---|
| `mod.rs` | Public Tauri commands `rdp_connect`, `rdp_disconnect`, `rdp_test_connection`; the `RdpOptions`/`GatewayOpt`/`PerformanceFlags`/`DriveRedirectOpt` config structs parsed from `options_json`; vault secret resolution; session-credential reuse for the gateway. |
| `ws.rs` | Bind a `127.0.0.1:0` listener, return `ws_port`, accept one WS upgrade, run the relay (outgoing→WS pump, WS→control reader, session driver, idle watchdog). Owns the binary WS tag protocol and `parse_binary_control`. |
| `session.rs` | Drives IronRDP end-to-end: `ClientConnector` → TLS upgrade → CredSSP/NLA finalize → `ActiveStage` loop. Attaches the IronRDP `CliprdrClient`, `Rdpsnd`, `Rdpdr`, and `DisplayControlClient` (via `DrdynvcClient`) backends; converts fast-path input; handles `DeactivateAll` reactivation and the resize-reconnect fallback. Also hosts the `ClipboardBridge` and the `RdpsndWsBackend`/`TaomniCliprdrBackend` adapters. |
| `transport.rs` | The `RdpStream` enum (`Tcp` / `Gateway`) and `open_transport` async constructor returning a unified `AsyncRead + AsyncWrite` (direct / proxy / gateway). |
| `frame.rs` | The stable RGBA tile wire format (`TileHeader` / `DecodedTile`), tile validation, and color helpers. IronRDP performs the actual bitmap/RemoteFX/surface decode into a framebuffer; `session.rs` slices tiles out of it. |
| `input.rs` | `KeyEvent` / `PointerEvent` / `PointerWheelEvent` types shared by `ws.rs` and `session.rs`, plus a minimal `code_to_scancode` table for tests. |
| `rdpdr.rs` | The `LocalDriveBackend` that implements IronRDP's `RdpdrBackend` trait — one mapped local folder → one redirected drive, with `safe_join` path sandboxing and the full IO-request handler set (Create/Read/Write/Close/Query{Information,Directory,Volume}/SetInformation). |
| `gateway/mod.rs` | RD Gateway (MS-TSGU) RPC-over-HTTPS twin-channel transport: the authenticated HTTPS pair, RTS bootstrap, TsProxy handshake, and the `GatewayStream` (`AsyncRead + AsyncWrite`). |
| `gateway/ndr.rs` | NDR encode/decode for the TsProxy* RPC stubs (create/authorize/make-call/create-channel/close). |
| `gateway/ntlm.rs` | Hand-rolled NTLMv2 type 1/2/3 framing, HMAC-MD5, and the Type3 MIC. |
| `gateway/rpch.rs` | RPC-over-HTTP RTS PDUs (CONN/A1, CONN/B1, CONN/A3, CONN/C2). |

**Survives from the original hand-rolled route — framing/codec helpers with
round-trip tests, NOT on the live path** (IronRDP owns the real work):

| File | Note |
|---|---|
| `cliprdr.rs` | Only `paths_to_uri_list` / `uri_list_to_paths` are live — reused by the global clipboard commands in `config/mod.rs` for the non-Windows `text/uri-list` shim. The hand-written CLIPRDR PDU/format-list/FILEDESCRIPTORW codecs are unused (IronRDP's `CliprdrClient` handles CLIPRDR). |
| `rdpsnd.rs` | Unused. `session.rs` uses IronRDP's `Rdpsnd` + `RdpsndClientHandler`; this module's `WaveFormat`/`pick_pcm_format`/Wave-confirm framing is dead. |
| `rfx.rs` | RFX *envelope* framing only; the DWT/Quant/RLGR decoder was never written. RemoteFX is decoded by IronRDP (`client_codecs_capabilities(["remotefx"])`). Unused on the live path. |
| `pdu/{tpkt,x224,nego,mcs}.rs` | Hand-rolled TPKT/X.224/Negotiation/MCS PDUs from the pre-IronRDP route. IronRDP's connector performs the real negotiation; these are unused outside their own tests. |

> These four leftover modules are candidates for cleanup; they duplicate
> IronRDP functionality and exist only because the early implementation
> hand-rolled the protocol before the IronRDP delegation was adopted.

`AppState` (`src-tauri/src/state.rs`) gained:

```rust
pub rdp_sessions: Arc<RwLock<HashMap<String, RdpSession>>>,
```

`RdpSession` (defined in `ws.rs`) carries `control_tx`, `ws_port`, and
`cancel`. The three commands are registered in `src-tauri/src/lib.rs` next to
the VNC ones; RDP spawns no autostart.

### Transport stack (`rdp/transport.rs`)

`open_transport(host, port, network, gateway)` returns an `RdpTransport`
wrapping an `RdpStream` enum (`Tcp(TcpStream)` | `Gateway(GatewayStream)`),
both implementing `AsyncRead + AsyncWrite + Unpin + Send`. Selection:

```text
1. gateway present        → gateway::open_tunnel (host/port = inner RDP target)
2. proxy_kind "" | "none"  → direct TCP (establish_transport with proxy forced off)
3. proxy_kind http|socks5 → establish_transport (HTTP-CONNECT / SOCKS5 + auth)
4. anything else          → Err("Proxy type '…' is not implemented for RDP")
```

Reuse:
- `src-tauri/src/terminal/network.rs::establish_transport` — already implements
  HTTP-CONNECT and SOCKS5 with auth, and short-circuits to direct TCP when
  `proxy_kind == "none"`; nothing else to write for proxy/direct mode.

Everything above the transport — X.224 negotiation, TLS, MCS, … — is IronRDP's;
the session does not know which path carried the bytes.

### RD Gateway (`rdp/gateway/`)

The original plan put this in a single `gateway.rs`; it shipped split across
`gateway/{mod,ndr,ntlm,rpch}.rs`. MS-TSGU is RPC-over-HTTPS with two parallel
HTTPS channels (RPC_IN_DATA + RPC_OUT_DATA) carrying TsProxy* RPC calls.
Implementation:

1. **HTTPS transport** — open two `rustls`-backed TLS streams to `gateway:443`
   via `ironrdp_tls::upgrade` (`gateway/mod.rs`).
2. **HTTP authentication to the gateway** — Basic and Negotiate (NTLM v2),
   in `gateway/ntlm.rs` (no monolithic SSPI crate). The NTLMv2 Type3 MIC is
   computed from the Type1/Type2/Type3 messages.
3. **RTS bootstrap** — CONN/A1, CONN/B1, CONN/A3, CONN/C2 RTS PDUs in
   `gateway/rpch.rs`.
4. **TsProxy RPC sequence** (MS-TSGU §3.7): `TsProxyCreateTunnel` →
   `TsProxyAuthorizeTunnel` → `TsProxyMakeTunnelCall` → `TsProxyCreateChannel`
   → `TsProxySetupReceivePipe` (on OUT) + `TsProxySendToServer` (on IN). NDR
   stub encode/decode lives in `gateway/ndr.rs`; DCE/RPC PDU framing in
   `gateway/mod.rs`.
5. **Inner RDP CredSSP** — after `TsProxyCreateChannel`, the resulting
   `GatewayStream` is handed to the same IronRDP session path as direct TCP;
   NLA/CredSSP remains the target-server RDP authentication layer.
6. `GatewayStream` implements `AsyncRead + AsyncWrite` by serializing
   reads/writes onto OUT/IN through background reader/writer tasks.
7. Cleanup: `TsProxyCloseChannel` + `TsProxyCloseTunnel` on drop / cancel, and
   the OUT reader task is cancelled on drop.

Why hand-rolled: there is no maintained Rust crate for MS-TSGU. IronRDP's
transport-agnostic design is exactly the seam we need. There is no real
RD Gateway test environment, so acceptance for this path is Rust unit coverage
plus an ignored live smoke (`live_rdg_tunnel_opens`).

### Virtual channels

Clipboard, audio, and drive redirection plug into `ironrdp-session` via the
SVC/DVC abstraction. Display resize uses `drdynvc` +
`DisplayControlClient`. Server pointer changes are configured for IronRDP
software rendering (`pointer_software_rendering: true`), so cursor updates are
composited into graphics frames and do not need a separate frontend cursor
path right now.

**CLIPRDR with multi-file copy/paste** (IronRDP `CliprdrClient`, glue in
`session.rs`)
- The IronRDP `CliprdrClient` owns CLIPRDR caps negotiation and PDU framing.
  `session.rs` provides a `TaomniCliprdrBackend` implementing IronRDP's
  `CliprdrBackend` trait and a `ClipboardBridge` that queues actions
  (advertise formats, request remote data, submit data/file-contents).
- Client caps advertised: `STREAM_FILECLIP_ENABLED | FILECLIP_NO_FILE_PATHS`.
  Formats: `CF_UNICODETEXT` and the file-list format (`FileGroupDescriptorW`).
- Server→client (Windows → us): on remote copy, prefer Unicode text; else
  request the file-group descriptor, parse it via IronRDP's `PackedFileList`,
  issue `FileContentsRequest`s (RANGE), stream chunks into a temp staging dir,
  then notify the frontend with a `clipboard_files` message carrying both the
  staged paths and a `text/uri-list` string.
- Client→server (us → Windows): when the host clipboard holds text or files,
  `collect_local_clipboard_files` walks the selection (sandboxed, ≤4096 items)
  and the bridge advertises the format + answers remote `FileContents`
  requests with bytes streamed from disk.
- The only hand-written CLIPRDR code still on the live path is the
  `text/uri-list` shim in `rdp/cliprdr.rs` (`paths_to_uri_list` /
  `uri_list_to_paths`), reused by the global clipboard commands in
  `config/mod.rs`. The frontend uses `src/lib/clipboard.ts` (`writeFiles` /
  `readFiles`) to round-trip OS file clipboards; it does not handle the blobs.

**RDPSND audio playback** (IronRDP `Rdpsnd`, glue in `session.rs`)
- `session.rs` attaches IronRDP's `Rdpsnd` with an `RdpsndWsBackend`
  implementing `RdpsndClientHandler`. It advertises a single PCM
  44.1 kHz / 16-bit / stereo format; IronRDP handles the SNDPROLOG/Wave/
  WaveConfirm framing and the wave clock.
- Each `wave()` callback emits an `AUDIO`-tagged WS frame: a 16-byte header
  (sample rate, channels, bits, timestamp, format-no) + PCM, parsed by
  `parseAudioFrame` in `src/lib/rdp.ts`.
- The frontend plays PCM via the Web Audio `AudioContext` buffer-source queue
  in `RdpPanel.tsx` (scheduled against `nextTime`); audio is gated on
  `redirectAudio === "play"`.

**RDPDR drive redirection** (IronRDP `Rdpdr`, backend in `rdp/rdpdr.rs`)
- `build_drive_channel` constructs IronRDP's `Rdpdr` with a `LocalDriveBackend`
  (implements `RdpdrBackend`) announcing one `FILESYSTEM` device named after a
  user-chosen local folder.
- Implements the IO request handlers IronRDP dispatches — Create, Read, Write,
  Close, Query{Information,Directory,Volume}, SetInformation, DeviceControl.
- Sandboxed to a single canonicalized root via `safe_join` (rejects `..` and
  drive-letter escapes). Server acceptance is surfaced as a `drive-ready`
  status; rejection as `drive-rejected`.

## Frontend

### Tab plumbing (mirrors VNC)

| New / changed file | Purpose |
|---|---|
| `src/components/rdp/RdpPanel.tsx` | Canvas viewer, WS client, input capture, scaling, Web Audio playback, status overlay. **The toolbar is built inline here using the shared `FloatingToolbar`** — there is no separate `RdpToolbar.tsx` (the original plan called for one). Includes reconnect / fit-1:1 / resize / detach / maximize, plus the detached-window reattach + OS-fullscreen controls. |
| `src/stores/rdpStore.ts` | `Record<tabId, RdpConnectionState>`, same shape as `vncStore.ts`. |
| `src/lib/rdp.ts` | IPC wrappers (`rdpConnect`, `rdpDisconnect`, `rdpTestConnection`), the binary WS codec (`encodeKey/Pointer/Resize/Wheel`, `parseFrameTile`, `parseAudioFrame`), and the `keyEventToScancode` table. |
| `src/types/rdp.ts` | `RdpOptions` + parse/serialize (mirrors the Rust `RdpOptions`); `Tab` gains an optional `rdp?` in `src/types/index.ts`. |
| `src/layouts/MainLayout.tsx` | `openRdpTab` in the connect flow; always-mounts RDP panels (`rdpTabs.map(...)`); also wires **detach-to-window + reattach** for RDP tabs (not in the original plan). |
| `src/components/session/forms/RdpOptionsForm.tsx` | The RDP options editor rendered by `SessionEditor`. |

WS framing follows the VNC pattern: a 1-byte channel tag selects between
inbound `frame` (RGBA tile), `audio` (PCM), `cursor`, `clipboard`, `status`
and outbound key/pointer/resize/wheel/ping/ack. RDP uses set-1 scancodes (with
an extended-key bit) where VNC used keysyms.

### Session config (`options_json` for RDP)

Persist these under `SessionConfig.options_json` (the column already exists,
no migration needed):

```jsonc
{
  "domain": "CORP",
  "color_depth": 32,
  "screen_w": 1920, "screen_h": 1080,
  "nla": true,
  "performance": {
    "wallpaper": false, "themes": false, "font_smooth": true,
    "disable_full_window_drag": true, "disable_menu_animations": true,
    "disable_cursor_shadow": true
  },
  "redirect_clipboard": true,
  "redirect_audio": "play",          // "play" | "off"
  "redirect_drive": { "enabled": false, "label": "TAOMNI", "path": "" },
  "gateway": {                        // optional; when present, overrides direct/proxy path
    "host": "rdg.example.com",
    "port": 443,
    "username": "user@CORP",
    "password": null,                 // or a vault:<id> secret reference
    "auth": "ntlm",                   // "basic" | "ntlm"
    "use_session_creds": true
  }
}
```

The Rust side serializes camelCase (`#[serde(rename_all = "camelCase")]`), so
the persisted keys are `colorDepth`, `screenW`, `redirectClipboard`, etc.; the
snippet above uses the conceptual field names. When `use_session_creds` is
true, the serializer drops the gateway username/password (they are filled from
the RDP session credentials at connect time), and an empty gateway block is
dropped entirely.

The TypeScript mirror lives in `src/types/rdp.ts` and `RdpOptionsForm` lives in
`src/components/session/forms/RdpOptionsForm.tsx`. `SessionEditor.tsx` renders
the form when the selected protocol is RDP and persists the normalized options
into the existing `options_json` column. Reuse the existing `NetworkSettings`
proxy editor unchanged for HTTP/SOCKS5; the gateway section is RDP-specific and
lives only in `RdpOptionsForm`.

### i18n

Strings go through the existing i18n framework. RDP keys live under `rdp.*`
(status, toolbar labels, and `rdp.options.*`) in
`src/lib/i18n/locales/en.ts` and `src/lib/i18n/locales/zh-CN.ts`.

## Cargo dependencies

`src-tauri/Cargo.toml` pins the IronRDP 0.14 family (**upgraded from 0.8**):

```toml
ironrdp = { version = "0.14.0", features = ["connector", "session", "graphics", "input", "cliprdr", "rdpdr", "rdpsnd", "svc", "dvc", "displaycontrol"] }
ironrdp-tls = { version = "0.2.0", features = ["rustls"] }
ironrdp-tokio = { version = "0.8.0", features = ["reqwest-rustls-ring"] }
rustls = { version = "0.23", default-features = false, features = ["ring", "std"] }
```

`base64`, `rand`, `uuid`, `tokio-tungstenite`, and `reqwest` (rustls) are
already in the tree and reused. The RD Gateway NTLM helper uses `aes`/`sha2`
style primitives via its own HMAC-MD5 implementation in `gateway/ntlm.rs`.

## Dev/browser mode

RDP is desktop-only.
- `vite-plugins/rdpProxy.ts` is registered in `vite.config.ts` (dev only) and
  returns `501 not implemented` for the bridge endpoint, so `pnpm dev` does not
  crash when `src/lib/rdp.ts` imports `@tauri-apps/api/core`.
- `src/stubs/tauri-core.ts` now special-cases `rdp_connect` /
  `rdp_disconnect` / `rdp_test_connection`: they throw a clear "RDP is only
  available in the desktop build" error instead of silently falling through to
  the `default` warn-and-return-undefined branch.

## Implementation order (as built)

1. `rdp/mod.rs` skeleton + `rdp/ws.rs` + `rdp/transport.rs` (direct only) + IPC
   plumbing + minimal `RdpPanel`. ✅
2. IronRDP wired up — display + keyboard/mouse, NLA/CredSSP, codec autodetect.
   ✅ (the active-stage graphics loop is what fixed the original black screen).
3. Proxy mode via `establish_transport`. ✅
4. CLIPRDR via IronRDP `CliprdrClient`: Unicode text + file group descriptor /
   file contents, with the `text/uri-list` shim for non-Windows. ✅
5. RDPSND via IronRDP `Rdpsnd` + Web Audio playback. ✅
6. RDPDR with one mapped folder (`LocalDriveBackend`). ✅
7. RD Gateway (`gateway/{mod,ndr,ntlm,rpch}.rs`) — biggest single piece; unit
   tested + ignored live smoke (no real RDG env). ✅
8. RemoteFX — **decoded by IronRDP** (codecs advertised in `build_ironrdp_config`).
   The standalone `rfx.rs` envelope parser was never finished into a decoder and
   is unused; this step is satisfied by IronRDP, not by `rfx.rs`.
9. Polish: reconnect, status overlay, perf flags, error toasts, maximize, and
   detach-to-window. ✅

## Critical files (as built)

Created:
- `src-tauri/src/rdp/{mod,ws,session,frame,transport,input,rdpdr,cliprdr,rdpsnd,rfx}.rs`
  (`cliprdr`/`rdpsnd`/`rfx` and `pdu/*` are leftover framing/codec helpers — see
  the backend table; only `frame`/`input` and the IronRDP backends are live).
- `src-tauri/src/rdp/pdu/{mod,tpkt,x224,nego,mcs}.rs` (hand-rolled, unused on the
  live path).
- `src-tauri/src/rdp/gateway/{mod,ndr,ntlm,rpch}.rs`.
- `src/components/rdp/RdpPanel.tsx` (toolbar is inline via `FloatingToolbar`;
  no separate `RdpToolbar.tsx`).
- `src/components/session/forms/RdpOptionsForm.tsx`
- `src/stores/rdpStore.ts`
- `src/lib/rdp.ts`
- `src/types/rdp.ts`
- `vite-plugins/rdpProxy.ts`
- Tests: `src/lib/rdp.test.ts` (24 cases); Rust unit tests inline across the
  `rdp` modules (RPC/NDR/NTLM round-trips in `gateway/*`, CLIPRDR/RFX/RDPSND
  codec round-trips, RDPDR path-sandbox + IO handlers) plus 5 ignored direct
  live tests and 1 ignored RDG live smoke. QA: `qa-ui-auto-tests` feature
  `F9.7` (status `partial`) + `TC-111-rdp-session-scaffold.testcase.yaml`.

Modified:
- `src-tauri/src/state.rs` — `rdp_sessions` field.
- `src-tauri/src/lib.rs` — registers the three commands; no autostart.
- `src-tauri/Cargo.toml` — IronRDP 0.14 crates.
- `src-tauri/src/config/mod.rs` — `clipboard_read_files` / `clipboard_write_files`
  reuse the `rdp::cliprdr` URI-list shim.
- `src/types/index.ts` — `Tab.rdp?`.
- `src/layouts/MainLayout.tsx` — RDP open + always-mount + detach-to-window.
- `src/components/session/SessionEditor.tsx` — renders `RdpOptionsForm` for RDP.
- `vite.config.ts` — registers `rdpProxy` in dev mode.
- `src/lib/i18n/locales/{en,zh-CN}.ts` — `rdp.*` keys.

Outstanding vs. plan:
- Leftover hand-rolled modules (`pdu/*`, `rfx.rs`, `rdpsnd.rs`, the CLIPRDR codec
  half of `cliprdr.rs`) are unused and can be pruned.

Shipped after the initial plan:
- `src/stubs/tauri-core.ts` now throws a clear desktop-only error for the three
  RDP commands in browser preview.
- `src-tauri/src/session/models.rs` documents the `options_json` shape near
  `SessionType::RDP`.
- A Refresh Rect path (`RdpControl::Refresh` → `request_full_refresh`) forces a
  full desktop redraw: automatically after reactivation and shortly after each
  `connected` event (fixes the stale screen after the Windows logon→desktop
  transition), plus a manual toolbar "Refresh screen" button.
- The RDP editor renders its options as a dedicated section tab (parallel to
  Network/Bookmark, replacing the Terminal tab) and defaults NLA off.
- `rdp_connect` reaps its `rdp_sessions` map entry when the relay's cancellation
  token fires, so detached/closed sessions no longer linger in the map.

## Verification

After each implementation step:

```bash
pnpm install                                              # if deps changed
.\node_modules\.bin\tsc.CMD -b                            # frontend type check
cargo check --manifest-path src-tauri/Cargo.toml
.\node_modules\.bin\vitest.CMD run src\lib\rdp.test.ts    # frontend unit
cargo test --manifest-path src-tauri/Cargo.toml rdp::     # rust unit tests
pnpm tauri dev                                            # manual: open an RDP tab, check canvas
```

Live Rust tests are gated behind `#[ignore]` and require
`TAOMNI_RDP_LIVE_HOST` / `_USER` / `_PASS` (direct) or
`TAOMNI_RDP_GATEWAY_LIVE_*` (gateway); run them explicitly with
`cargo test … rdp:: -- --ignored` against a reachable host.

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

`qa-ui-auto` smoke: `TC-111-rdp-session-scaffold.testcase.yaml` covers the
saved-session RDP panel/toolbar route in browser mode. A full
"canvas reaches `connected`" smoke needs a native run or a live xrdp container
(browser preview is stubbed and cannot complete a real RDP session).
