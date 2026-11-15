//! Best-effort URL mediation, not a security boundary: the child CSP only
//! permits this token root. Unrecognized/escaped CSS/JS syntax fails closed.
use super::html::Preview;
use super::network;
use regex::{Captures, Regex};
use std::sync::OnceLock;

pub(super) fn reference(
    value: &str,
    base: Option<&url::Url>,
    preview: &Preview,
) -> Result<String, String> {
    if value.starts_with(&preview.url_root())
        || value.starts_with("data:")
        || value.starts_with("blob:")
        || value.starts_with('#')
    {
        return Ok(value.into());
    }
    let url = match base {
        Some(base) => base.join(value),
        None if value.starts_with("//") => url::Url::parse(&format!("https:{value}")),
        None => url::Url::parse(value),
    };
    let Ok(url) = url else {
        return Ok(value.into());
    };
    if !matches!(url.scheme(), "http" | "https") {
        return Ok(value.into());
    }
    if !preview.allow_network {
        return Ok(value.into());
    }
    network::resource_url(url.as_str(), preview)
}

pub(super) fn css(
    source: &str,
    base: Option<&url::Url>,
    preview: &Preview,
) -> Result<String, String> {
    static URLS: OnceLock<Regex> = OnceLock::new();
    static IMPORTS: OnceLock<Regex> = OnceLock::new();
    let urls = URLS.get_or_init(|| {
        Regex::new(r#"(?is)url\(\s*(?:"([^"\\]*)"|'([^'\\]*)'|([^)'"\\]*))\s*\)"#).unwrap()
    });
    let mut failure = None;
    let rewritten = urls.replace_all(source, |captures: &Captures<'_>| {
        let original = captures
            .get(1)
            .or_else(|| captures.get(2))
            .or_else(|| captures.get(3))
            .unwrap()
            .as_str()
            .trim();
        match reference(original, base, preview) {
            Ok(value) => format!("url(\"{}\")", value.replace('"', "%22")),
            Err(error) => {
                failure = Some(error);
                "url(\"about:blank\")".into()
            }
        }
    });
    let imports = IMPORTS
        .get_or_init(|| Regex::new(r#"(?is)@import\s+(?:"([^"\\]*)"|'([^'\\]*)')"#).unwrap());
    let rewritten = imports
        .replace_all(&rewritten, |captures: &Captures<'_>| {
            let value = captures
                .get(1)
                .or_else(|| captures.get(2))
                .unwrap()
                .as_str();
            match reference(value, base, preview) {
                Ok(value) => format!("@import \"{}\"", value.replace('"', "%22")),
                Err(error) => {
                    failure = Some(error);
                    "@import \"about:blank\"".into()
                }
            }
        })
        .into_owned();
    failure.map_or(Ok(rewritten), Err)
}

pub(super) fn srcset(
    value: &str,
    base: Option<&url::Url>,
    preview: &Preview,
) -> Result<String, String> {
    // Data-URI commas are ambiguous without a complete HTML srcset parser;
    // preserve the data-only case, rather than inventing an outbound request.
    if value.trim_start().starts_with("data:") {
        return Ok(value.into());
    }
    value
        .split(',')
        .map(|candidate| {
            let mut parts = candidate.split_whitespace();
            let source = parts.next().unwrap_or("");
            let descriptor = parts.collect::<Vec<_>>().join(" ");
            reference(source, base, preview).map(|url| {
                if descriptor.is_empty() {
                    url
                } else {
                    format!("{url} {descriptor}")
                }
            })
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|parts| parts.join(", "))
}
