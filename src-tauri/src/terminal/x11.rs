//! Cross-platform X11 forwarding support.
//!
//! Taomni does not ship its own X server (writing an X11 display server is a
//! multi-year effort and an explicit non-goal). Instead it forwards the remote
//! application's X11 traffic — tunneled back over the SSH connection — into a
//! *system* X server the user already runs:
//!
//! * **Linux** - the native Xorg/Xwayland session (`$DISPLAY`, usually `:0`
//!   over the `/tmp/.X11-unix/X0` Unix socket).
//! * **macOS** - XQuartz (installs an X server reachable over a Unix socket
//!   referenced by `$DISPLAY`, e.g. `/private/tmp/.../org.xquartz:0`).
//! * **Windows** - VcXsrv / X410 / Xming / WSLg, which listen on a TCP port
//!   (`6000 + display`) on `127.0.0.1`.
//!
//! This module resolves where that local X server lives, reads the
//! MIT-MAGIC-COOKIE-1 authentication record for it, and reports whether one is
//! reachable so the UI can show honest status (and prompt to install XQuartz /
//! VcXsrv when it isn't).

use serde::Serialize;
use std::path::PathBuf;

/// TCP base port for X11. Display `N` listens on `X11_TCP_BASE + N`.
const X11_TCP_BASE: u16 = 6000;

/// Where the local X server can be reached for a parsed `$DISPLAY`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum XTarget {
    /// Unix-domain socket path (Linux/macOS), e.g. `/tmp/.X11-unix/X0`.
    Unix(PathBuf),
    /// TCP endpoint (Windows X servers, or an explicit `host:display`).
    Tcp { host: String, port: u16 },
}

/// A fully resolved local X11 endpoint plus the auth cookie to present to the
/// remote side when requesting forwarding.
#[derive(Debug, Clone)]
pub struct XDisplay {
    /// The raw `$DISPLAY` value this was resolved from (e.g. `:0`, `:10.0`).
    pub display: String,
    /// Screen number (the `.S` in `host:D.S`); defaults to 0.
    pub screen: u32,
    /// Where to actually connect locally.
    pub target: XTarget,
    /// Authentication protocol name, e.g. `MIT-MAGIC-COOKIE-1`. Empty when no
    /// cookie was found (the server may be running with auth disabled).
    pub auth_protocol: String,
    /// Raw cookie bytes (NOT hex). Empty when none was found.
    pub auth_cookie: Vec<u8>,
}

/// Status of the local X server, surfaced to the UI.
#[derive(Debug, Clone, Serialize)]
pub struct XServerStatus {
    /// Whether a usable local X server was detected.
    pub available: bool,
    /// The `$DISPLAY` we resolved (empty if unset).
    pub display: String,
    /// Human-readable endpoint, e.g. `/tmp/.X11-unix/X0` or `127.0.0.1:6000`.
    pub endpoint: String,
    /// Whether an auth cookie was found for the display.
    pub has_cookie: bool,
    /// Detected provider, e.g. `Xorg`, `XQuartz`, `VcXsrv`, `WSLg`, `unknown`.
    pub provider: String,
    /// When unavailable, a localized-key-friendly hint id for the UI:
    /// `install-xquartz` | `install-vcxsrv` | `no-display` | `unreachable`.
    pub hint: Option<String>,
}

/// Parse a `$DISPLAY` string of the form `[host]:display[.screen]`.
///
/// Returns `(host, display_number, screen_number)`. An empty host means a
/// local (Unix socket) connection.
fn parse_display(display: &str) -> Result<(String, u32, u32), String> {
    let display = display.trim();
    if display.is_empty() {
        return Err("DISPLAY is empty".to_string());
    }
    // Split host from the `:display.screen` tail at the LAST colon so IPv6
    // literals (rare for X but possible) don't get mangled.
    let colon = display
        .rfind(':')
        .ok_or_else(|| format!("malformed DISPLAY '{}': missing ':'", display))?;
    let host = &display[..colon];
    let rest = &display[colon + 1..];
    if rest.is_empty() {
        return Err(format!("malformed DISPLAY '{}': no display number", display));
    }
    let (disp_str, screen_str) = match rest.split_once('.') {
        Some((d, s)) => (d, Some(s)),
        None => (rest, None),
    };
    let disp_num: u32 = disp_str
        .parse()
        .map_err(|_| format!("malformed DISPLAY '{}': bad display number", display))?;
    let screen: u32 = match screen_str {
        Some(s) => s
            .parse()
            .map_err(|_| format!("malformed DISPLAY '{}': bad screen number", display))?,
        None => 0,
    };
    Ok((host.to_string(), disp_num, screen))
}

/// Resolve a parsed display into a concrete local connection target.
///
/// `local-host` forms (`:N`, `unix:N`, `localhost:N`, `127.0.0.1:N` on
/// platforms with Unix sockets) prefer the Unix socket; everything else, and
/// all of Windows, resolves to TCP `host:(6000+N)`.
fn resolve_target(host: &str, disp_num: u32) -> XTarget {
    let is_local = host.is_empty()
        || host == "unix"
        || host == "localhost"
        || host == "127.0.0.1"
        || host == "::1";

    #[cfg(unix)]
    {
        if is_local {
            // Honor a non-abstract custom socket dir if the platform uses one.
            let path = unix_socket_path(disp_num);
            return XTarget::Unix(path);
        }
    }

    let host = if host.is_empty() || host == "unix" {
        "127.0.0.1".to_string()
    } else {
        host.to_string()
    };
    XTarget::Tcp {
        host,
        port: X11_TCP_BASE + disp_num as u16,
    }
}

#[cfg(unix)]
fn unix_socket_path(disp_num: u32) -> PathBuf {
    // macOS XQuartz sets DISPLAY to a launchd socket under a private temp dir
    // (e.g. /private/tmp/com.apple.launchd.XXX/org.xquartz:0). When DISPLAY
    // points straight at such a path we keep it; otherwise fall back to the
    // standard /tmp/.X11-unix/X<n>.
    PathBuf::from(format!("/tmp/.X11-unix/X{}", disp_num))
}

/// Read the current `$DISPLAY`. On Windows, if unset but an X server is
/// listening on the default port, fall back to `localhost:0`.
pub fn current_display() -> Option<String> {
    if let Ok(d) = std::env::var("DISPLAY") {
        if !d.trim().is_empty() {
            return Some(d);
        }
    }
    None
}

/// Resolve the full local X11 endpoint + cookie for the active `$DISPLAY`
/// (or an explicit override). This is what the SSH layer needs to set up
/// forwarding.
pub fn resolve(display_override: Option<&str>) -> Result<XDisplay, String> {
    let display = match display_override {
        Some(d) if !d.trim().is_empty() => d.trim().to_string(),
        _ => current_display()
            .or_else(default_display)
            .ok_or_else(|| "no X display configured ($DISPLAY unset)".to_string())?,
    };

    let (host, disp_num, screen) = parse_display(&display)?;

    // macOS XQuartz puts an absolute socket path in DISPLAY; detect and use it
    // verbatim instead of synthesizing /tmp/.X11-unix.
    let target = if display.starts_with('/') {
        // Form: /path/to/socket:N — strip the trailing :N we already parsed.
        let socket = display
            .rsplit_once(':')
            .map(|(p, _)| p.to_string())
            .unwrap_or_else(|| display.clone());
        XTarget::Unix(PathBuf::from(socket))
    } else {
        resolve_target(&host, disp_num)
    };

    let (auth_protocol, auth_cookie) = read_auth_cookie(&display, disp_num).unwrap_or_default();

    Ok(XDisplay {
        display,
        screen,
        target,
        auth_protocol,
        auth_cookie,
    })
}

/// Platform default display when `$DISPLAY` is unset: Windows X servers and
/// WSLg conventionally expose `:0`, so probe that.
fn default_display() -> Option<String> {
    #[cfg(windows)]
    {
        return Some("localhost:0.0".to_string());
    }
    #[allow(unreachable_code)]
    {
        None
    }
}

/// Locate the Xauthority file: `$XAUTHORITY` if set, else `~/.Xauthority`.
fn xauthority_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("XAUTHORITY") {
        if !p.trim().is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    dirs::home_dir().map(|h| h.join(".Xauthority"))
}

/// One entry in an `.Xauthority` file.
struct XAuthEntry {
    family: u16,
    address: Vec<u8>,
    number: Vec<u8>,
    name: Vec<u8>,
    data: Vec<u8>,
}

/// Parse the binary `.Xauthority` format. Each record is five length-prefixed
/// (big-endian u16) byte strings: family, address, number, name, data.
/// See `man Xau` / `XauReadAuth`.
fn parse_xauthority(bytes: &[u8]) -> Vec<XAuthEntry> {
    let mut entries = Vec::new();
    let mut pos = 0usize;
    let read_u16 = |b: &[u8], p: &mut usize| -> Option<u16> {
        if *p + 2 > b.len() {
            return None;
        }
        let v = u16::from_be_bytes([b[*p], b[*p + 1]]);
        *p += 2;
        Some(v)
    };
    let read_bytes = |b: &[u8], p: &mut usize, len: usize| -> Option<Vec<u8>> {
        if *p + len > b.len() {
            return None;
        }
        let v = b[*p..*p + len].to_vec();
        *p += len;
        Some(v)
    };
    while let Some(family) = read_u16(bytes, &mut pos) {
        let parse_field = |b: &[u8], p: &mut usize| -> Option<Vec<u8>> {
            let len = read_u16(b, p)? as usize;
            read_bytes(b, p, len)
        };
        let (Some(address), Some(number), Some(name), Some(data)) = (
            parse_field(bytes, &mut pos),
            parse_field(bytes, &mut pos),
            parse_field(bytes, &mut pos),
            parse_field(bytes, &mut pos),
        ) else {
            break;
        };
        entries.push(XAuthEntry {
            family,
            address,
            number,
            name,
            data,
        });
    }
    entries
}

// Xauthority address family constants (from X11/Xauth.h).
const FAMILY_LOCAL: u16 = 256; // FamilyLocal — `address` is the hostname
const FAMILY_WILD: u16 = 65535; // FamilyWild — matches anything

/// Read the MIT-MAGIC-COOKIE-1 (or whatever protocol is stored) for `display`.
///
/// Matching mirrors libXau: prefer an entry whose family/address matches this
/// host and whose display number matches; fall back to a `FamilyWild` entry or
/// the first entry for the right display number. Returns `(protocol, cookie)`.
fn read_auth_cookie(_display: &str, disp_num: u32) -> Option<(String, Vec<u8>)> {
    let path = xauthority_path()?;
    let bytes = std::fs::read(&path).ok()?;
    let entries = parse_xauthority(&bytes);
    if entries.is_empty() {
        return None;
    }

    let want_number = disp_num.to_string();
    let hostname = hostname_bytes();

    // Score candidates: exact host + display match wins, then wild family,
    // then any entry whose display number matches.
    let mut best: Option<&XAuthEntry> = None;
    let mut best_score = -1i32;
    for e in &entries {
        // Display number must match (empty number field acts as wildcard).
        let number_ok = e.number.is_empty() || e.number == want_number.as_bytes();
        if !number_ok {
            continue;
        }
        let mut score = 0;
        if e.number == want_number.as_bytes() {
            score += 1;
        }
        match e.family {
            FAMILY_WILD => score += 2,
            FAMILY_LOCAL => {
                if let Some(h) = &hostname {
                    if &e.address == h {
                        score += 4;
                    } else {
                        score += 1;
                    }
                } else {
                    score += 1;
                }
            }
            _ => score += 1,
        }
        if score > best_score {
            best_score = score;
            best = Some(e);
        }
    }

    let entry = best?;
    let protocol = String::from_utf8_lossy(&entry.name).to_string();
    if entry.data.is_empty() {
        return None;
    }
    Some((protocol, entry.data.clone()))
}

#[cfg(unix)]
fn hostname_bytes() -> Option<Vec<u8>> {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .ok()
        .map(|s| s.trim().as_bytes().to_vec())
        .or_else(|| {
            std::env::var("HOSTNAME")
                .ok()
                .map(|s| s.trim().as_bytes().to_vec())
        })
}

#[cfg(not(unix))]
fn hostname_bytes() -> Option<Vec<u8>> {
    std::env::var("COMPUTERNAME")
        .ok()
        .map(|s| s.trim().as_bytes().to_vec())
}

/// Probe the local X server and report status for the UI.
///
/// "Available" means: a `$DISPLAY` resolves AND a TCP/Unix connection to the
/// resolved endpoint succeeds within a short timeout. The provider string is a
/// best-effort label (Xorg / XQuartz / VcXsrv / WSLg / unknown).
pub fn detect() -> XServerStatus {
    let display = match current_display().or_else(default_display) {
        Some(d) => d,
        None => {
            return XServerStatus {
                available: false,
                display: String::new(),
                endpoint: String::new(),
                has_cookie: false,
                provider: provider_label(false),
                hint: Some(install_hint()),
            };
        }
    };

    let resolved = match resolve(Some(&display)) {
        Ok(r) => r,
        Err(_) => {
            return XServerStatus {
                available: false,
                display,
                endpoint: String::new(),
                has_cookie: false,
                provider: provider_label(false),
                hint: Some("no-display".to_string()),
            };
        }
    };

    let (endpoint, reachable) = match &resolved.target {
        XTarget::Unix(path) => {
            let endpoint = path.to_string_lossy().to_string();
            let ok = probe_unix(path);
            (endpoint, ok)
        }
        XTarget::Tcp { host, port } => {
            let endpoint = format!("{}:{}", host, port);
            let ok = probe_tcp(host, *port);
            (endpoint, ok)
        }
    };

    XServerStatus {
        available: reachable,
        display: resolved.display,
        endpoint,
        has_cookie: !resolved.auth_cookie.is_empty(),
        provider: provider_label(reachable),
        hint: if reachable {
            None
        } else {
            Some("unreachable".to_string())
        },
    }
}

#[cfg(unix)]
fn probe_unix(path: &std::path::Path) -> bool {
    use std::os::unix::net::UnixStream;
    use std::time::Duration;
    // A successful connect is enough to know an X server is listening.
    if let Ok(stream) = UnixStream::connect(path) {
        let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
        return true;
    }
    false
}

#[cfg(not(unix))]
fn probe_unix(_path: &std::path::Path) -> bool {
    false
}

fn probe_tcp(host: &str, port: u16) -> bool {
    use std::net::{TcpStream, ToSocketAddrs};
    use std::time::Duration;
    let addr_iter = match (host, port).to_socket_addrs() {
        Ok(a) => a,
        Err(_) => return false,
    };
    for addr in addr_iter {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
            return true;
        }
    }
    false
}

/// Best-effort provider label for the current platform.
fn provider_label(reachable: bool) -> String {
    if !reachable {
        return "unknown".to_string();
    }
    #[cfg(target_os = "linux")]
    {
        // WSLg sets WAYLAND_DISPLAY + a /mnt/wslg path; otherwise assume Xorg.
        if std::env::var("WSL_DISTRO_NAME").is_ok()
            || std::path::Path::new("/mnt/wslg").exists()
        {
            return "WSLg".to_string();
        }
        return "Xorg".to_string();
    }
    #[cfg(target_os = "macos")]
    {
        return "XQuartz".to_string();
    }
    #[cfg(target_os = "windows")]
    {
        return "X server".to_string();
    }
    #[allow(unreachable_code)]
    {
        "unknown".to_string()
    }
}

/// Platform-appropriate install hint id when no server/display is present.
fn install_hint() -> String {
    #[cfg(target_os = "macos")]
    {
        return "install-xquartz".to_string();
    }
    #[cfg(target_os = "windows")]
    {
        return "install-vcxsrv".to_string();
    }
    #[allow(unreachable_code)]
    {
        "no-display".to_string()
    }
}

/* ----------------------------- local stream ----------------------------- */

use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

/// A connection to the local X server, abstracting over the Unix-socket
/// (Linux/macOS) and TCP (Windows / remote) cases so the SSH bridge can pump
/// bytes uniformly.
pub enum LocalXStream {
    #[cfg(unix)]
    Unix(tokio::net::UnixStream),
    Tcp(tokio::net::TcpStream),
}

impl XDisplay {
    /// Open a fresh connection to the local X server this display points at.
    /// Called once per X11 channel the remote opens.
    pub async fn connect_local(&self) -> Result<LocalXStream, String> {
        match &self.target {
            XTarget::Unix(path) => {
                #[cfg(unix)]
                {
                    let s = tokio::net::UnixStream::connect(path)
                        .await
                        .map_err(|e| format!("connect X unix socket {:?}: {}", path, e))?;
                    Ok(LocalXStream::Unix(s))
                }
                #[cfg(not(unix))]
                {
                    Err(format!(
                        "unix X socket {:?} unsupported on this platform",
                        path
                    ))
                }
            }
            XTarget::Tcp { host, port } => {
                let s = tokio::net::TcpStream::connect((host.as_str(), *port))
                    .await
                    .map_err(|e| format!("connect X server {}:{}: {}", host, port, e))?;
                let _ = s.set_nodelay(true);
                Ok(LocalXStream::Tcp(s))
            }
        }
    }
}

impl AsyncRead for LocalXStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            #[cfg(unix)]
            LocalXStream::Unix(s) => Pin::new(s).poll_read(cx, buf),
            LocalXStream::Tcp(s) => Pin::new(s).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for LocalXStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        match self.get_mut() {
            #[cfg(unix)]
            LocalXStream::Unix(s) => Pin::new(s).poll_write(cx, buf),
            LocalXStream::Tcp(s) => Pin::new(s).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            #[cfg(unix)]
            LocalXStream::Unix(s) => Pin::new(s).poll_flush(cx),
            LocalXStream::Tcp(s) => Pin::new(s).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            #[cfg(unix)]
            LocalXStream::Unix(s) => Pin::new(s).poll_shutdown(cx),
            LocalXStream::Tcp(s) => Pin::new(s).poll_shutdown(cx),
        }
    }
}

/* -------------------------------- tests --------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_display_local() {
        assert_eq!(parse_display(":0").unwrap(), (String::new(), 0, 0));
        assert_eq!(parse_display(":10.0").unwrap(), (String::new(), 10, 0));
        assert_eq!(parse_display(":1.2").unwrap(), (String::new(), 1, 2));
    }

    #[test]
    fn parse_display_with_host() {
        assert_eq!(
            parse_display("localhost:0").unwrap(),
            ("localhost".to_string(), 0, 0)
        );
        assert_eq!(
            parse_display("192.168.1.5:10.0").unwrap(),
            ("192.168.1.5".to_string(), 10, 0)
        );
    }

    #[test]
    fn parse_display_errors() {
        assert!(parse_display("").is_err());
        assert!(parse_display("nocolon").is_err());
        assert!(parse_display(":").is_err());
        assert!(parse_display(":abc").is_err());
    }

    #[test]
    #[cfg(unix)]
    fn resolve_target_local_is_unix() {
        match resolve_target("", 0) {
            XTarget::Unix(p) => assert_eq!(p, PathBuf::from("/tmp/.X11-unix/X0")),
            _ => panic!("expected unix socket for local display"),
        }
        match resolve_target("localhost", 10) {
            XTarget::Unix(p) => assert_eq!(p, PathBuf::from("/tmp/.X11-unix/X10")),
            _ => panic!("expected unix socket for localhost"),
        }
    }

    #[test]
    fn resolve_target_remote_is_tcp() {
        match resolve_target("192.168.1.5", 0) {
            XTarget::Tcp { host, port } => {
                assert_eq!(host, "192.168.1.5");
                assert_eq!(port, 6000);
            }
            _ => panic!("expected tcp for remote host"),
        }
        match resolve_target("display.example.com", 12) {
            XTarget::Tcp { host, port } => {
                assert_eq!(host, "display.example.com");
                assert_eq!(port, 6012);
            }
            _ => panic!("expected tcp"),
        }
    }

    #[test]
    fn xauthority_roundtrip() {
        // Build one MIT-MAGIC-COOKIE-1 record for display :0 on host "myhost".
        fn put(buf: &mut Vec<u8>, field: &[u8]) {
            buf.extend_from_slice(&(field.len() as u16).to_be_bytes());
            buf.extend_from_slice(field);
        }
        let cookie = vec![0xDEu8, 0xAD, 0xBE, 0xEF, 0x00, 0x11, 0x22, 0x33];
        let mut buf = Vec::new();
        buf.extend_from_slice(&FAMILY_LOCAL.to_be_bytes());
        put(&mut buf, b"myhost");
        put(&mut buf, b"0");
        put(&mut buf, b"MIT-MAGIC-COOKIE-1");
        put(&mut buf, &cookie);

        let entries = parse_xauthority(&buf);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].family, FAMILY_LOCAL);
        assert_eq!(entries[0].address, b"myhost");
        assert_eq!(entries[0].number, b"0");
        assert_eq!(entries[0].name, b"MIT-MAGIC-COOKIE-1");
        assert_eq!(entries[0].data, cookie);
    }

    #[test]
    fn xauthority_truncated_is_ignored() {
        // A trailing partial record must not panic and must be dropped.
        let mut buf = Vec::new();
        buf.extend_from_slice(&FAMILY_WILD.to_be_bytes());
        buf.extend_from_slice(&(6u16).to_be_bytes()); // claims 6 bytes…
        buf.extend_from_slice(b"abc"); // …but only 3 present
        let entries = parse_xauthority(&buf);
        assert!(entries.is_empty());
    }
}
