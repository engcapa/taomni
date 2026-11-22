# SocksCap binaries (macOS)

## xray-core

Core-backed upstreams (Shadowsocks / Trojan / VMess / VLESS / WireGuard) are
served by a bundled `xray` process. It is a third-party redistributable
(xray-core, MPL-2.0) and is **not committed** — stage it before packaging:

```bash
# Intel
pwsh scripts/fetch-xray.ps1 -Platform macos
# Apple silicon
pwsh scripts/fetch-xray.ps1 -Platform macos-arm64
```

The script pins the release tag and verifies a SHA256 before extracting `xray`
into this directory. `tauri.conf.json` bundles `resources/sockscap/**/*` into
the app resource dir; the runtime resolves it via
`sockscap::paths::resolve_xray_exe` (override with `SOCKSCAP_XRAY_DIR` /
`SOCKSCAP_XRAY_EXE`).

## Mitmproxy Redirector

The signed macOS SocksCap module carries the original Mitmproxy Redirector
app archive, its upstream manifest and MIT notice under
`src-tauri/plugins/sockscap/resources/macos/redirector/0.12.11/`.
Stage the archive before building the macOS module.

```bash
SOCKSCAP_DOWNLOAD_PROXY=http://127.0.0.1:8080 \
  bash scripts/stage-mitmproxy-redirector-macos.sh --stage
```

The proxy variable is optional. The script fixes version `0.12.11`, verifies
the wheel and app-tar SHA-256 values, checks both bundle identities and Team ID
`S8XHQB96PW`, validates the nested signature, and requires both `arm64` and
`x86_64` slices. `--check` verifies an already staged archive on macOS.

The setup guide checks the installed app at
`/Applications/Mitmproxy Redirector.app`. When installation is needed, the
core reads the resource from the enabled, signed module and rechecks the
upstream digest in a private staging directory before requesting macOS
authorization. The core installer and updater exclude the Redirector archive.
