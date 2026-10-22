//! Real in-process SSH/SFTP server built on `russh` 0.61 + `russh-sftp` 2.
//!
//! This is NOT an OS/PAM gateway: authentication is checked against credentials
//! supplied in the server config (a password and/or a single authorized public
//! key), never against system accounts. A successful shell session spawns the
//! local default shell in a PTY (via [`crate::terminal::pty`]) and bridges it to
//! the SSH channel; the `sftp` subsystem is served by an in-process handler
//! rooted at a configured directory.
//!
//! ## Port forwarding (RFC 4254 §7)
//!
//! - **Local / dynamic** (`-L` / `-D` on the client): handled as
//!   `direct-tcpip` channels — we TCP-connect to the requested destination and
//!   bridge bytes bidirectionally. Dynamic SOCKS is client-side only; the
//!   server just sees a stream of `direct-tcpip` opens.
//! - **Remote** (`-R` on the client): `tcpip-forward` binds a local listener;
//!   each inbound TCP connection opens a `forwarded-tcpip` channel back to the
//!   client and is bridged the same way. `cancel-tcpip-forward` tears the
//!   listener down; all reverse listeners die with the SSH session.
//!
//! Server-specific config (`config.extra`, camelCase as sent by the frontend):
//!   - `password`      (string) accept password auth matching this value
//!   - `authorizedKey` (string) accept publickey auth matching this OpenSSH key
//!                              line ("ssh-ed25519 AAAA... [comment]")
//!   - `authorizedKeyPath` (string) path to a .pub / authorized_keys file
//!   - `allowedUsers`  (string) comma-separated usernames; empty = any username
//!   - `rootDir`       (string) SFTP/shell root directory; default = home dir
//!
//! If neither `password` nor `authorizedKey` is set the server refuses to start
//! (an SSH server that accepts anyone is almost never what the user wants).

mod authentication;

mod connection;

mod listener;

mod requests;

mod forwarding;

mod pty_session;

mod sftp_handler;

mod sftp_paths;

mod sftp_attributes;

#[cfg(test)]
mod tests;

pub use listener::start;
