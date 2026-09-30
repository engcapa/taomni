//! Account auto-configuration from an e-mail address (TASK-14, AC-43).
//!
//! Order (Thunderbird-like): built-in table (offline) → ISPDB
//! (`autoconfig.thunderbird.net`) → `autoconfig.<domain>` →
//! `<domain>/.well-known/autoconfig` → guessed `imap./smtp.<domain>` hosts
//! that accept a TCP connection. The online steps send the domain (and, for
//! the provider's own autoconfig host, the address) to third parties, so
//! they only run when the user allows it.

use std::net::ToSocketAddrs;
use std::time::Duration;

use quick_xml::Reader;
use quick_xml::events::Event;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailServerGuess {
    pub host: String,
    pub port: u16,
    /// "TLS" | "STARTTLS" | "None" (the session editor's values).
    pub security: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailAutoconfig {
    /// "builtin" | "ispdb" | "provider" | "well-known" | "guess".
    pub source: String,
    /// "gmail" | "outlook" | "custom" (OAuth presets exist for the first two).
    pub provider: String,
    pub imap: MailServerGuess,
    pub smtp: MailServerGuess,
}

fn server(host: &str, port: u16, security: &str) -> MailServerGuess {
    MailServerGuess {
        host: host.to_string(),
        port,
        security: security.to_string(),
    }
}

fn builtin(domain: &str) -> Option<MailAutoconfig> {
    let config = |provider: &str, imap: MailServerGuess, smtp: MailServerGuess| MailAutoconfig {
        source: "builtin".into(),
        provider: provider.into(),
        imap,
        smtp,
    };
    let tls = |imap: &str, smtp: &str| (server(imap, 993, "TLS"), server(smtp, 465, "TLS"));
    let (provider, (imap, smtp)) = match domain {
        "gmail.com" | "googlemail.com" => ("gmail", tls("imap.gmail.com", "smtp.gmail.com")),
        "outlook.com" | "hotmail.com" | "live.com" | "msn.com" | "outlook.cn" => (
            "outlook",
            (
                server("outlook.office365.com", 993, "TLS"),
                server("smtp.office365.com", 587, "STARTTLS"),
            ),
        ),
        "qq.com" | "foxmail.com" | "vip.qq.com" => ("custom", tls("imap.qq.com", "smtp.qq.com")),
        "exmail.qq.com" => ("custom", tls("imap.exmail.qq.com", "smtp.exmail.qq.com")),
        "163.com" => ("custom", tls("imap.163.com", "smtp.163.com")),
        "126.com" => ("custom", tls("imap.126.com", "smtp.126.com")),
        "yeah.net" => ("custom", tls("imap.yeah.net", "smtp.yeah.net")),
        "sina.com" | "sina.cn" => ("custom", tls("imap.sina.com", "smtp.sina.com")),
        "sohu.com" => ("custom", tls("imap.sohu.com", "smtp.sohu.com")),
        "aliyun.com" => ("custom", tls("imap.aliyun.com", "smtp.aliyun.com")),
        "139.com" => ("custom", tls("imap.139.com", "smtp.139.com")),
        "icloud.com" | "me.com" | "mac.com" => (
            "custom",
            (
                server("imap.mail.me.com", 993, "TLS"),
                server("smtp.mail.me.com", 587, "STARTTLS"),
            ),
        ),
        "yahoo.com" | "ymail.com" => ("custom", tls("imap.mail.yahoo.com", "smtp.mail.yahoo.com")),
        "aol.com" => ("custom", tls("imap.aol.com", "smtp.aol.com")),
        "fastmail.com" | "fastmail.fm" => ("custom", tls("imap.fastmail.com", "smtp.fastmail.com")),
        "zoho.com" | "zohomail.com" => ("custom", tls("imap.zoho.com", "smtp.zoho.com")),
        "gmx.com" | "gmx.net" | "gmx.de" => (
            "custom",
            (
                server("imap.gmx.net", 993, "TLS"),
                server("mail.gmx.net", 587, "STARTTLS"),
            ),
        ),
        "yandex.com" | "yandex.ru" => ("custom", tls("imap.yandex.com", "smtp.yandex.com")),
        _ => return None,
    };
    Some(config(provider, imap, smtp))
}

fn security_of(socket_type: &str) -> &'static str {
    match socket_type.trim().to_ascii_uppercase().as_str() {
        "SSL" | "TLS" => "TLS",
        "STARTTLS" => "STARTTLS",
        _ => "None",
    }
}

/// Parse a Thunderbird `clientConfig` document (first IMAP + first SMTP).
pub(super) fn parse_client_config(xml: &str, email: &str, source: &str) -> Option<MailAutoconfig> {
    let (local, domain) = email.split_once('@').unwrap_or((email, ""));
    let expand = |value: &str| {
        value
            .replace("%EMAILADDRESS%", email)
            .replace("%EMAILLOCALPART%", local)
            .replace("%EMAILDOMAIN%", domain)
    };
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut current: Option<&'static str> = None; // "imap" | "smtp"
    let mut field = String::new();
    let mut entry = (String::new(), 0u16, String::new());
    let mut imap: Option<MailServerGuess> = None;
    let mut smtp: Option<MailServerGuess> = None;
    loop {
        match reader.read_event() {
            Ok(Event::Start(tag)) => {
                let name = String::from_utf8_lossy(tag.local_name().as_ref()).to_string();
                if name == "incomingServer" || name == "outgoingServer" {
                    let kind = tag
                        .attributes()
                        .flatten()
                        .find(|attr| attr.key.as_ref() == b"type")
                        .map(|attr| String::from_utf8_lossy(&attr.value).to_ascii_lowercase());
                    current = match (name.as_str(), kind.as_deref()) {
                        ("incomingServer", Some("imap")) if imap.is_none() => Some("imap"),
                        ("outgoingServer", Some("smtp")) if smtp.is_none() => Some("smtp"),
                        _ => None,
                    };
                    entry = (String::new(), 0, String::new());
                } else {
                    field = name;
                }
            }
            Ok(Event::Text(text)) => {
                if current.is_some() {
                    let value = text.decode().map(|v| v.to_string()).unwrap_or_default();
                    match field.as_str() {
                        "hostname" => entry.0 = expand(&value),
                        "port" => entry.1 = value.trim().parse().unwrap_or(0),
                        "socketType" => entry.2 = value,
                        _ => {}
                    }
                }
            }
            Ok(Event::End(tag)) => {
                let name = String::from_utf8_lossy(tag.local_name().as_ref()).to_string();
                if name == "incomingServer" || name == "outgoingServer" {
                    if let Some(kind) = current.take() {
                        if !entry.0.is_empty() && entry.1 != 0 {
                            let guess = server(&entry.0, entry.1, security_of(&entry.2));
                            if kind == "imap" {
                                imap = Some(guess);
                            } else {
                                smtp = Some(guess);
                            }
                        }
                    }
                }
                field.clear();
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    let imap = imap?;
    let smtp = smtp?;
    let provider = if imap.host.ends_with("gmail.com") {
        "gmail"
    } else if imap.host.ends_with("office365.com") || imap.host.ends_with("outlook.com") {
        "outlook"
    } else {
        "custom"
    };
    Some(MailAutoconfig {
        source: source.to_string(),
        provider: provider.to_string(),
        imap,
        smtp,
    })
}

async fn fetch_config(
    client: &reqwest::Client,
    url: &str,
    email: &str,
    source: &str,
) -> Option<MailAutoconfig> {
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let text = response.text().await.ok()?;
    parse_client_config(&text, email, source)
}

fn reachable(host: &str, port: u16) -> bool {
    let Ok(addrs) = (host, port).to_socket_addrs() else {
        return false;
    };
    addrs
        .take(2)
        .any(|addr| std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(3)).is_ok())
}

fn domain_of(email: &str) -> Option<String> {
    let domain = email
        .trim()
        .rsplit_once('@')?
        .1
        .trim()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let valid = !domain.is_empty()
        && domain.contains('.')
        && domain
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.');
    valid.then_some(domain)
}

/// Discover IMAP/SMTP settings for `email`. `allow_online` enables the
/// ISPDB and provider lookups (they reveal the domain/address).
#[tauri::command]
pub async fn mail_autoconfig(
    email: String,
    allow_online: bool,
) -> Result<Option<MailAutoconfig>, String> {
    let email = email.trim().to_string();
    let Some(domain) = domain_of(&email) else {
        return Err("enter a full e-mail address (name@example.com)".into());
    };
    if let Some(found) = builtin(&domain) {
        return Ok(Some(found));
    }
    if allow_online {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()
            .map_err(|e| format!("HTTP client setup failed: {e}"))?;
        let encoded: String = url::form_urlencoded::byte_serialize(email.as_bytes()).collect();
        let candidates = [
            (
                format!("https://autoconfig.thunderbird.net/v1.1/{domain}"),
                "ispdb",
            ),
            (
                format!("https://autoconfig.{domain}/mail/config-v1.1.xml?emailaddress={encoded}"),
                "provider",
            ),
            (
                format!("https://{domain}/.well-known/autoconfig/mail/config-v1.1.xml"),
                "well-known",
            ),
        ];
        for (url, source) in candidates {
            if let Some(found) = fetch_config(&client, &url, &email, source).await {
                return Ok(Some(found));
            }
        }
    }
    let guessed = tokio::task::spawn_blocking(move || {
        let imap = [
            (format!("imap.{domain}"), 993, "TLS"),
            (format!("mail.{domain}"), 993, "TLS"),
        ]
        .into_iter()
        .find(|(host, port, _)| reachable(host, *port))?;
        let smtp = [
            (format!("smtp.{domain}"), 465, "TLS"),
            (format!("smtp.{domain}"), 587, "STARTTLS"),
            (format!("mail.{domain}"), 465, "TLS"),
        ]
        .into_iter()
        .find(|(host, port, _)| reachable(host, *port))?;
        Some(MailAutoconfig {
            source: "guess".into(),
            provider: "custom".into(),
            imap: server(&imap.0, imap.1, imap.2),
            smtp: server(&smtp.0, smtp.1, smtp.2),
        })
    })
    .await
    .map_err(|e| format!("autoconfig task failed: {e}"))?;
    Ok(guessed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_table_covers_common_providers() {
        let qq = builtin("qq.com").unwrap();
        assert_eq!(qq.imap, server("imap.qq.com", 993, "TLS"));
        assert_eq!(qq.smtp, server("smtp.qq.com", 465, "TLS"));
        assert_eq!(builtin("163.com").unwrap().imap.host, "imap.163.com");
        assert_eq!(builtin("gmail.com").unwrap().provider, "gmail");
        assert_eq!(builtin("hotmail.com").unwrap().smtp.security, "STARTTLS");
        assert!(builtin("example.org").is_none());
    }

    #[test]
    fn parses_thunderbird_client_config() {
        let xml = r#"<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="example.org">
    <incomingServer type="pop3"><hostname>pop.example.org</hostname><port>995</port><socketType>SSL</socketType></incomingServer>
    <incomingServer type="imap">
      <hostname>imap.%EMAILDOMAIN%</hostname>
      <port>143</port>
      <socketType>STARTTLS</socketType>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.example.org</hostname>
      <port>465</port>
      <socketType>SSL</socketType>
    </outgoingServer>
  </emailProvider>
</clientConfig>"#;
        let config = parse_client_config(xml, "me@example.org", "ispdb").unwrap();
        assert_eq!(config.imap, server("imap.example.org", 143, "STARTTLS"));
        assert_eq!(config.smtp, server("smtp.example.org", 465, "TLS"));
        assert_eq!(config.source, "ispdb");
        assert_eq!(config.provider, "custom");
        assert!(parse_client_config("<clientConfig/>", "me@example.org", "ispdb").is_none());
    }

    #[test]
    fn rejects_non_addresses() {
        assert_eq!(domain_of("me@Example.ORG."), Some("example.org".into()));
        assert_eq!(domain_of("nope"), None);
        assert_eq!(domain_of("me@localhost"), None);
        assert_eq!(domain_of("me@exa mple.org"), None);
    }
}
