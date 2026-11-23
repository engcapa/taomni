//! POP3 connection, authentication, and command framing.

use super::Pop3Mailbox;
use std::io::{BufRead as _, BufReader, Read, Write};
use std::net::TcpStream;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};

use crate::imap_auth::{MailAuthMode, xoauth2_sasl_response};
use crate::tls::{MailConnectionSecurity, certificate_error_hint, tls_connector};

// ---------------------------------------------------------------------------
// Protocol client
// ---------------------------------------------------------------------------

struct Pop3Conn<S: Read + Write> {
    reader: BufReader<S>,
}

impl<S: Read + Write> Pop3Conn<S> {
    fn new(stream: S) -> Self {
        Self {
            reader: BufReader::new(stream),
        }
    }

    fn line(&mut self) -> Result<String, String> {
        let mut line = String::new();
        self.reader
            .read_line(&mut line)
            .map_err(|e| format!("POP3 read failed: {e}"))?;
        if line.is_empty() {
            return Err("POP3 server closed the connection".into());
        }
        Ok(line.trim_end_matches(['\r', '\n']).to_string())
    }

    fn status(&mut self) -> Result<String, String> {
        let line = self.line()?;
        if let Some(rest) = line.strip_prefix("+OK") {
            Ok(rest.trim().to_string())
        } else {
            Err(format!("POP3 error: {line}"))
        }
    }

    fn command(&mut self, command: &str) -> Result<String, String> {
        let stream = self.reader.get_mut();
        stream
            .write_all(format!("{command}\r\n").as_bytes())
            .and_then(|_| stream.flush())
            .map_err(|e| format!("POP3 write failed: {e}"))?;
        self.status()
    }

    /// Body of a multi-line response, dot-unstuffed, CRLF line endings.
    fn multiline(&mut self) -> Result<Vec<u8>, String> {
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

    fn into_inner(self) -> S {
        self.reader.into_inner()
    }
}

/// APOP digest: MD5(timestamp + password), lowercase hex (RFC 1939 §7).
fn apop_digest(timestamp: &str, password: &str) -> String {
    use md5::{Digest, Md5};
    Md5::digest(format!("{timestamp}{password}").as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn greeting_timestamp(greeting: &str) -> Option<String> {
    let start = greeting.find('<')?;
    let end = greeting[start..].find('>')? + start;
    let stamp = &greeting[start..=end];
    stamp.contains('@').then(|| stamp.to_string())
}

fn authenticate<S: Read + Write>(
    conn: &mut Pop3Conn<S>,
    options: &Pop3Connection<'_>,
    greeting: &str,
    encrypted: bool,
) -> Result<(), String> {
    let user = options.username;
    let secret = options.secret;
    match options.authentication {
        MailAuthMode::OAuth2 => {
            let sasl = BASE64.encode(xoauth2_sasl_response(user, secret));
            conn.command(&format!("AUTH XOAUTH2 {sasl}"))
                .map(|_| ())
                .map_err(|e| format!("POP3 XOAUTH2 authentication failed: {e}"))
        }
        MailAuthMode::Password => {
            // Prefer APOP when an unencrypted connection offers a challenge.
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

enum Pop3Transport {
    Plain(Pop3Conn<TcpStream>),
    Tls(Pop3Conn<native_tls::TlsStream<TcpStream>>),
}

pub struct Pop3Connection<'a> {
    pub server_name: &'a str,
    pub security: MailConnectionSecurity,
    pub trusted_certificate: Option<&'a str>,
    pub username: &'a str,
    pub secret: &'a str,
    pub authentication: MailAuthMode,
}

pub struct Pop3Session {
    transport: Pop3Transport,
}

macro_rules! each {
    ($client:ident, $conn:ident => $body:expr) => {
        match &mut $client.transport {
            Pop3Transport::Plain($conn) => $body,
            Pop3Transport::Tls($conn) => $body,
        }
    };
}

impl Pop3Session {
    pub fn open(stream: TcpStream, options: &Pop3Connection<'_>) -> Result<Self, String> {
        let trusted = options.trusted_certificate;
        let pinned = trusted.is_some_and(|v| !v.trim().is_empty());
        let tls = |stream: TcpStream| -> Result<native_tls::TlsStream<TcpStream>, String> {
            tls_connector(trusted)?
                .connect(options.server_name, stream)
                .map_err(|e| {
                    certificate_error_hint(&format!("POP3 TLS handshake failed: {e}"), pinned)
                })
        };
        let transport = match options.security {
            MailConnectionSecurity::Tls => {
                let mut conn = Pop3Conn::new(tls(stream)?);
                let greeting = conn.status()?;
                authenticate(&mut conn, options, &greeting, true)?;
                Pop3Transport::Tls(conn)
            }
            MailConnectionSecurity::Starttls => {
                let mut plain = Pop3Conn::new(stream);
                plain.status()?;
                plain
                    .command("STLS")
                    .map_err(|e| format!("POP3 STLS failed: {e}"))?;
                let mut conn = Pop3Conn::new(tls(plain.into_inner())?);
                authenticate(&mut conn, options, "", true)?;
                Pop3Transport::Tls(conn)
            }
            MailConnectionSecurity::None => {
                let mut conn = Pop3Conn::new(stream);
                let greeting = conn.status()?;
                authenticate(&mut conn, options, &greeting, false)?;
                Pop3Transport::Plain(conn)
            }
        };
        let mut client = Self { transport };
        client.stat()?;
        Ok(client)
    }

    fn stat(&mut self) -> Result<(usize, u64), String> {
        let reply = each!(self, c => c.command("STAT"))?;
        let mut parts = reply.split_whitespace();
        let count = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        let size = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        Ok((count, size))
    }

    /// `(message number, unique id)` in server order.
    pub fn uidl(&mut self) -> Result<Vec<(u32, String)>, String> {
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

    pub fn retr(&mut self, number: u32) -> Result<Vec<u8>, String> {
        each!(self, c => c.command(&format!("RETR {number}")))
            .map_err(|e| format!("POP3 RETR {number} failed: {e}"))?;
        each!(self, c => c.multiline())
    }

    pub fn dele(&mut self, number: u32) -> Result<(), String> {
        each!(self, c => c.command(&format!("DELE {number}")))
            .map(|_| ())
            .map_err(|e| format!("POP3 DELE {number} failed: {e}"))
    }

    /// QUIT commits DELE marks (RFC 1939 UPDATE state).
    pub fn quit(mut self) -> Result<(), String> {
        each!(self, c => c.command("QUIT")).map(|_| ())
    }
}

impl Pop3Mailbox for Pop3Session {
    fn uidl(&mut self) -> Result<Vec<(u32, String)>, String> {
        Pop3Session::uidl(self)
    }

    fn retr(&mut self, number: u32) -> Result<Vec<u8>, String> {
        Pop3Session::retr(self, number)
    }

    fn dele(&mut self, number: u32) -> Result<(), String> {
        Pop3Session::dele(self, number)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apop_matches_rfc1939_example() {
        assert_eq!(
            apop_digest("<1896.697170952@dbc.mtview.ca.us>", "tanstaaf"),
            "c4c9334bac560ecc979e58001b3e22fb"
        );
    }

    #[test]
    fn multiline_preserves_dot_stuffing_and_binary_message_bytes() {
        let mut conn = Pop3Conn::new(std::io::Cursor::new(
            b"..first\r\nnormal\xff\r\n.\r\n".to_vec(),
        ));
        assert_eq!(conn.multiline().unwrap(), b".first\r\nnormal\xff\r\n");
    }
}
