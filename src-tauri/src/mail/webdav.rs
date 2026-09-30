//! Minimal WebDAV client shared by CardDAV (TASK-19) and CalDAV (TASK-20
//! phase 2): multistatus parsing, Basic/Bearer auth, manual redirects (so
//! PROPFIND stays PROPFIND) and RFC 6764 / RFC 6352 / RFC 4791 discovery
//! via `/.well-known`, `current-user-principal` and the home-set property.

use std::collections::HashMap;
use std::time::Duration;

use quick_xml::Reader;
use quick_xml::events::Event;
use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::{Method, Url};

/// What a discovery looks for (CardDAV address book or CalDAV calendar).
#[derive(Debug, Clone, Copy)]
pub(crate) struct DavKind {
    pub label: &'static str,
    pub well_known: &'static str,
    /// Home-set property local name (`addressbook-home-set`, `calendar-home-set`).
    pub home_prop: &'static str,
    /// Resource type of the collection (`addressbook`, `calendar`).
    pub collection_type: &'static str,
    /// `xmlns:x="..."` of the home-set property.
    pub namespace: &'static str,
}

pub(crate) const CARDDAV: DavKind = DavKind {
    label: "CardDAV",
    well_known: "carddav",
    home_prop: "addressbook-home-set",
    collection_type: "addressbook",
    namespace: "urn:ietf:params:xml:ns:carddav",
};

pub(crate) const CALDAV: DavKind = DavKind {
    label: "CalDAV",
    well_known: "caldav",
    home_prop: "calendar-home-set",
    collection_type: "calendar",
    namespace: "urn:ietf:params:xml:ns:caldav",
};

impl DavKind {
    fn discovery_body(&self) -> String {
        format!(
            r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:x="{}"><d:prop><d:resourcetype/><d:current-user-principal/><x:{}/><d:displayname/></d:prop></d:propfind>"#,
            self.namespace, self.home_prop
        )
    }
}

/// One `<response>` of a WebDAV multistatus with its successful props.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct DavResponse {
    pub href: String,
    /// Prop local name -> text (nested `<href>` text for principal/home;
    /// child element names for `resourcetype`).
    pub props: HashMap<String, String>,
}

pub(crate) fn parse_multistatus(xml: &str) -> Vec<DavResponse> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut responses = Vec::new();
    let mut current: Option<DavResponse> = None;
    let mut stack: Vec<String> = Vec::new();
    // Props of the current propstat, kept only when its status is 2xx.
    let mut pending: HashMap<String, String> = HashMap::new();
    let mut status_ok = true;
    let mut text = String::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(tag)) => {
                let name = String::from_utf8_lossy(tag.local_name().as_ref()).to_string();
                match name.as_str() {
                    "response" => current = Some(DavResponse::default()),
                    "propstat" => {
                        pending.clear();
                        status_ok = true;
                    }
                    _ => {}
                }
                // A child of <resourcetype> names the resource type.
                if stack.last().map(String::as_str) == Some("resourcetype") {
                    let entry = pending.entry("resourcetype".into()).or_default();
                    entry.push(' ');
                    entry.push_str(&name);
                }
                stack.push(name);
                text.clear();
            }
            Ok(Event::Empty(tag)) => {
                let name = String::from_utf8_lossy(tag.local_name().as_ref()).to_string();
                if stack.last().map(String::as_str) == Some("resourcetype") {
                    let entry = pending.entry("resourcetype".into()).or_default();
                    entry.push(' ');
                    entry.push_str(&name);
                } else if stack.iter().any(|s| s == "prop") {
                    pending.entry(name).or_default();
                }
            }
            Ok(Event::Text(t)) => {
                text.push_str(&t.decode().map(|v| v.to_string()).unwrap_or_default())
            }
            Ok(Event::GeneralRef(r)) => {
                let entity = String::from_utf8_lossy(r.as_ref()).to_string();
                text.push_str(match entity.as_str() {
                    "amp" => "&",
                    "lt" => "<",
                    "gt" => ">",
                    "quot" => "\"",
                    "apos" => "'",
                    _ => "",
                });
                if let Some(code) = entity.strip_prefix('#') {
                    let parsed = code.strip_prefix('x').map_or_else(
                        || code.parse::<u32>().ok(),
                        |hex| u32::from_str_radix(hex, 16).ok(),
                    );
                    if let Some(ch) = parsed.and_then(char::from_u32) {
                        text.push(ch);
                    }
                }
            }
            Ok(Event::CData(c)) => text.push_str(&String::from_utf8_lossy(c.as_ref())),
            Ok(Event::End(tag)) => {
                let name = String::from_utf8_lossy(tag.local_name().as_ref()).to_string();
                stack.pop();
                let parent = stack.last().cloned().unwrap_or_default();
                match name.as_str() {
                    "href" if parent == "response" => {
                        if let Some(response) = current.as_mut() {
                            response.href = text.trim().to_string();
                        }
                    }
                    "href" => {
                        // href inside a prop (current-user-principal etc.).
                        if let Some(prop) = stack.iter().skip_while(|s| *s != "prop").nth(1) {
                            pending.insert(prop.clone(), text.trim().to_string());
                        }
                    }
                    "status" if parent == "propstat" => {
                        status_ok = text
                            .split_whitespace()
                            .nth(1)
                            .is_some_and(|code| code.starts_with('2'));
                    }
                    "propstat" => {
                        if status_ok {
                            if let Some(response) = current.as_mut() {
                                response.props.extend(pending.drain());
                            }
                        }
                        pending.clear();
                    }
                    "response" => {
                        if let Some(response) = current.take() {
                            responses.push(response);
                        }
                    }
                    _ if parent == "prop" && name != "resourcetype" => {
                        pending
                            .entry(name)
                            .or_insert_with(|| text.trim().to_string());
                    }
                    _ => {}
                }
                text.clear();
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    responses
}

pub(crate) fn has_type(response: &DavResponse, kind: &str) -> bool {
    response.props.get("resourcetype").is_some_and(|types| {
        types
            .split_whitespace()
            .any(|t| t.eq_ignore_ascii_case(kind))
    })
}

pub(crate) enum DavAuth {
    Basic(String, String),
    Bearer(String),
}

pub(crate) struct DavClient {
    http: reqwest::Client,
    auth: DavAuth,
    kind: DavKind,
}

pub(crate) struct DavReply {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: String,
}

pub(crate) const XML: &str = "application/xml; charset=utf-8";
pub(crate) const PROPFIND_ETAGS: &str = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/></d:prop></d:propfind>"#;

impl DavClient {
    pub(crate) fn new(
        kind: DavKind,
        auth: DavAuth,
        allow_invalid_certs: bool,
    ) -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .danger_accept_invalid_certs(allow_invalid_certs)
            .build()
            .map_err(|e| format!("{} client: {e}", kind.label))?;
        Ok(Self { http, auth, kind })
    }

    pub(crate) async fn send(
        &self,
        method: &str,
        url: &Url,
        depth: Option<&str>,
        body: Option<(String, &'static str)>,
        extra: &[(&str, String)],
    ) -> Result<DavReply, String> {
        let method = Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
        // Follow redirects by hand so PROPFIND stays PROPFIND.
        let mut target = url.clone();
        for _ in 0..5 {
            let mut request = self.http.request(method.clone(), target.clone());
            request = match &self.auth {
                DavAuth::Basic(user, pass) => request.basic_auth(user, Some(pass)),
                DavAuth::Bearer(token) => request.bearer_auth(token),
            };
            if let Some(depth) = depth {
                request = request.header("Depth", depth);
            }
            for (name, value) in extra {
                request = request.header(*name, value.as_str());
            }
            if let Some((body, content_type)) = &body {
                request = request
                    .header("Content-Type", HeaderValue::from_static(content_type))
                    .body(body.clone());
            }
            let response = request
                .send()
                .await
                .map_err(|e| format!("{} {method} {target} failed: {e}", self.kind.label))?;
            let status = response.status().as_u16();
            if matches!(status, 301 | 302 | 303 | 307 | 308) {
                if let Some(location) = response
                    .headers()
                    .get("location")
                    .and_then(|v| v.to_str().ok())
                {
                    target = target
                        .join(location)
                        .map_err(|e| format!("{} redirect: {e}", self.kind.label))?;
                    continue;
                }
            }
            let headers = response.headers().clone();
            let body = response.text().await.unwrap_or_default();
            if status == 401 || status == 403 {
                return Err(format!(
                    "{} login rejected ({status}). Check the {} username; many providers need an app password.",
                    self.kind.label, self.kind.label
                ));
            }
            return Ok(DavReply {
                status,
                headers,
                body,
            });
        }
        Err(format!("{}: too many redirects", self.kind.label))
    }

    pub(crate) async fn propfind(
        &self,
        url: &Url,
        depth: &str,
        body: &str,
    ) -> Result<Vec<DavResponse>, String> {
        let reply = self
            .send(
                "PROPFIND",
                url,
                Some(depth),
                Some((body.to_string(), XML)),
                &[],
            )
            .await?;
        if reply.status != 207 {
            return Err(format!(
                "{} PROPFIND {url} returned {}",
                self.kind.label, reply.status
            ));
        }
        Ok(parse_multistatus(&reply.body))
    }

    /// Address book collection behind `start` (RFC 6764 bootstrap).
    pub(crate) async fn discover(&self, start: &Url) -> Result<Url, String> {
        let mut probe = vec![start.clone()];
        if start.path() == "/" || start.path().is_empty() {
            probe.insert(
                0,
                start
                    .join(&format!("/.well-known/{}", self.kind.well_known))
                    .map_err(|e| e.to_string())?,
            );
        }
        let mut last_error = format!("no {} collection found", self.kind.label);
        for url in probe {
            match self.discover_from(&url).await {
                Ok(found) => return Ok(found),
                Err(e) => last_error = e,
            }
        }
        Err(last_error)
    }

    async fn discover_from(&self, url: &Url) -> Result<Url, String> {
        let responses = self.propfind(url, "0", &self.kind.discovery_body()).await?;
        let first = responses.first().cloned().unwrap_or_default();
        if has_type(&first, self.kind.collection_type) {
            return Ok(url.clone());
        }
        let home = match first
            .props
            .get(self.kind.home_prop)
            .filter(|h| !h.is_empty())
        {
            Some(home) => url.join(home).map_err(|e| e.to_string())?,
            None => {
                let principal = first
                    .props
                    .get("current-user-principal")
                    .filter(|p| !p.is_empty())
                    .ok_or_else(|| format!("{url} is not a {} server", self.kind.label))?;
                let principal = url.join(principal).map_err(|e| e.to_string())?;
                let found = self
                    .propfind(&principal, "0", &self.kind.discovery_body())
                    .await?;
                let home = found
                    .first()
                    .and_then(|r| r.props.get(self.kind.home_prop).cloned())
                    .filter(|h| !h.is_empty())
                    .ok_or_else(|| {
                        format!(
                            "the {} principal has no {}",
                            self.kind.label, self.kind.home_prop
                        )
                    })?;
                principal.join(&home).map_err(|e| e.to_string())?
            }
        };
        let books = self
            .propfind(&home, "1", &self.kind.discovery_body())
            .await?;
        let book = books
            .iter()
            .find(|r| has_type(r, self.kind.collection_type))
            .ok_or_else(|| {
                format!(
                    "no {} collection in the {} home",
                    self.kind.collection_type, self.kind.label
                )
            })?;
        home.join(&book.href).map_err(|e| e.to_string())
    }
}

pub(crate) fn etag_of(headers: &HeaderMap) -> Option<String> {
    headers
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim().to_string())
}

/// Normalize an href to the collection's absolute path for comparisons.
pub(crate) fn href_path(collection: &Url, href: &str) -> String {
    collection
        .join(href)
        .map(|u| u.path().to_string())
        .unwrap_or_else(|_| href.to_string())
}
