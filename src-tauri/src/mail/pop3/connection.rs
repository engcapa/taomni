use super::limits::READ_TIMEOUT;
use crate::mail::MailAuthMode;
use crate::mail::MailConnectionSecurity;
use crate::mail::ResolvedMailAccount;
use crate::mail::certs;
use crate::mail::mail_effective_endpoint;
use crate::mail::tcp_connect;
use crate::mail::xoauth2_sasl_response;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use std::io::BufRead as _;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::net::TcpStream;

// ---------------------------------------------------------------------------
// Protocol client
// ---------------------------------------------------------------------------

pub(in crate::mail) struct Pop3Conn<S: Read + Write> {
    pub(super) reader: BufReader<S>,
}

impl<S: Read + Write> Pop3Conn<S> {
    pub(super) fn new(stream: S) -> Self {
        Self {
            reader: BufReader::new(stream),
        }
    }

    pub(super) fn line(&mut self) -> Result<String, String> {
        let mut line = String::new();
        self.reader
            .read_line(&mut line)
            .map_err(|e| format!("POP3 read failed: {e}"))?;
        if line.is_empty() {
            return Err("POP3 server closed the connection".into());
        }
        Ok(line.trim_end_matches(['\r', '\n']).to_string())
    }

    pub(super) fn status(&mut self) -> Result<String, String> {
        let line = self.line()?;
        if let Some(rest) = line.strip_prefix("+OK") {
            Ok(rest.trim().to_string())
        } else {
            Err(format!("POP3 error: {line}"))
        }
    }

    pub(super) fn command(&mut self, command: &str) -> Result<String, String> {
        let stream = self.reader.get_mut();
        stream
            .write_all(format!("{command}\r\n").as_bytes())
            .and_then(|_| stream.flush())
            .map_err(|e| format!("POP3 write failed: {e}"))?;
        self.status()
    }

    /// Body of a multi-line response, dot-unstuffed, CRLF line endings.
    pub(super) fn multiline(&mut self) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        loop {
            let mut raw = Vec::new();
            self.reader
                .read_until(b'\n', &mut raw)
                .map_err(|e| format!("POP3 read failed: {e}"))?;
            if raw.is_empty() {
                return Err("POP3 server closed the connection".into());
            }
            let line = raw
                .strip_suffix(b"\n")
                .map(|l| l.strip_suffix(b"\r").unwrap_or(l))
                .unwrap_or(&raw);
            if line == b"." {
                return Ok(out);
            }
            let line = line
                .strip_prefix(b".")
                .filter(|l| l.starts_with(b"."))
                .unwrap_or(line);
            out.extend_from_slice(line);
            out.extend_from_slice(b"\r\n");
        }
    }

    pub(super) fn into_inner(self) -> S {
        self.reader.into_inner()
    }
}

/// APOP digest: MD5(timestamp + password), lowercase hex (RFC 1939 §7).
pub(in crate::mail) fn apop_digest(timestamp: &str, password: &str) -> String {
    use md5::{Digest, Md5};
    Md5::digest(format!("{timestamp}{password}").as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub(super) fn greeting_timestamp(greeting: &str) -> Option<String> {
    let start = greeting.find('<')?;
    let end = greeting[start..].find('>')? + start;
    let stamp = &greeting[start..=end];
    stamp.contains('@').then(|| stamp.to_string())
}

pub(super) fn authenticate<S: Read + Write>(
    conn: &mut Pop3Conn<S>,
    account: &ResolvedMailAccount,
    greeting: &str,
    encrypted: bool,
) -> Result<(), String> {
    let user = account.imap_username.as_str();
    let secret = account.imap_password.as_str();
    match account.auth_mode {
        MailAuthMode::OAuth2 => {
            let sasl = BASE64.encode(xoauth2_sasl_response(user, secret));
            conn.command(&format!("AUTH XOAUTH2 {sasl}"))
                .map(|_| ())
                .map_err(|e| format!("POP3 XOAUTH2 authentication failed: {e}"))
        }
        MailAuthMode::Password => {
            // Plain USER/PASS only over TLS; APOP keeps the password off an
            // unencrypted wire when the server offers it.
            if !encrypted {
                if let Some(stamp) = greeting_timestamp(greeting) {
                    return conn
                        .command(&format!("APOP {user} {}", apop_digest(&stamp, secret)))
                        .map(|_| ())
                        .map_err(|e| format!("POP3 APOP authentication failed: {e}"));
                }
            }
            conn.command(&format!("USER {user}"))
                .map_err(|e| format!("POP3 USER rejected: {e}"))?;
            conn.command(&format!("PASS {secret}"))
                .map(|_| ())
                .map_err(|_| {
                    "POP3 authentication failed (check the user name and password)".to_string()
                })
        }
    }
}

pub(in crate::mail) enum Pop3Client {
    Plain(Pop3Conn<TcpStream>),
    Tls(Pop3Conn<native_tls::TlsStream<TcpStream>>),
}

impl Pop3Client {
    pub(in crate::mail) fn connect(
        account: &ResolvedMailAccount,
        runtime: &tokio::runtime::Handle,
    ) -> Result<Self, String> {
        let host = account.config.imap.host.trim();
        let port = account.config.imap.port;
        let (connect_host, connect_port, _forward) =
            mail_effective_endpoint(account, host, port, runtime)?;
        let stream = tcp_connect(&connect_host, connect_port)?;
        stream.set_read_timeout(Some(READ_TIMEOUT)).ok();
        stream.set_write_timeout(Some(READ_TIMEOUT)).ok();
        let trusted = account.config.imap.trusted_cert.as_deref();
        let pinned = trusted.is_some_and(|v| !v.trim().is_empty());
        let tls = |stream: TcpStream| -> Result<native_tls::TlsStream<TcpStream>, String> {
            certs::tls_connector(trusted)?
                .connect(host, stream)
                .map_err(|e| {
                    certs::certificate_error_hint(
                        &format!("POP3 TLS handshake failed: {e}"),
                        pinned,
                    )
                })
        };
        let mut client = match account.config.imap.security {
            MailConnectionSecurity::Tls => {
                let mut conn = Pop3Conn::new(tls(stream)?);
                let greeting = conn.status()?;
                authenticate(&mut conn, account, &greeting, true)?;
                Pop3Client::Tls(conn)
            }
            MailConnectionSecurity::Starttls => {
                let mut plain = Pop3Conn::new(stream);
                plain.status()?;
                plain
                    .command("STLS")
                    .map_err(|e| format!("POP3 STLS failed: {e}"))?;
                let mut conn = Pop3Conn::new(tls(plain.into_inner())?);
                authenticate(&mut conn, account, "", true)?;
                Pop3Client::Tls(conn)
            }
            MailConnectionSecurity::None => {
                let mut conn = Pop3Conn::new(stream);
                let greeting = conn.status()?;
                authenticate(&mut conn, account, &greeting, false)?;
                Pop3Client::Plain(conn)
            }
        };
        client.stat()?;
        Ok(client)
    }

    pub(in crate::mail) fn stat(&mut self) -> Result<(usize, u64), String> {
        let reply = each!(self, c => c.command("STAT"))?;
        let mut parts = reply.split_whitespace();
        let count = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        let size = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        Ok((count, size))
    }

    /// `(message number, unique id)` in server order.
    pub(in crate::mail) fn uidl(&mut self) -> Result<Vec<(u32, String)>, String> {
        each!(self, c => c.command("UIDL")).map_err(|e| format!("POP3 UIDL failed: {e}"))?;
        let body = each!(self, c => c.multiline())?;
        Ok(String::from_utf8_lossy(&body)
            .lines()
            .filter_map(|line| {
                let (number, id) = line.trim().split_once(' ')?;
                Some((number.parse().ok()?, id.trim().to_string()))
            })
            .collect())
    }

    pub(in crate::mail) fn retr(&mut self, number: u32) -> Result<Vec<u8>, String> {
        each!(self, c => c.command(&format!("RETR {number}")))
            .map_err(|e| format!("POP3 RETR {number} failed: {e}"))?;
        each!(self, c => c.multiline())
    }

    pub(in crate::mail) fn dele(&mut self, number: u32) -> Result<(), String> {
        each!(self, c => c.command(&format!("DELE {number}")))
            .map(|_| ())
            .map_err(|e| format!("POP3 DELE {number} failed: {e}"))
    }

    /// QUIT commits DELE marks (RFC 1939 UPDATE state).
    pub(in crate::mail) fn quit(mut self) -> Result<(), String> {
        let client = &mut self;
        each!(client, c => c.command("QUIT")).map(|_| ())
    }
}
