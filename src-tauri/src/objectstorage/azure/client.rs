use super::authentication::AzureAuth;
use super::authentication::HmacSha256;
use super::authentication::MS_VERSION;
use super::metadata::check;
use super::metadata::net_err;
use base64::Engine as _;
use hmac::{KeyInit, Mac};
use reqwest::Client;
use url::Url;

pub struct AzureClient {
    pub(super) http: Client,
    pub(super) account: String,
    /// Service base, e.g. `https://acct.blob.core.windows.net` (subdomain) or
    /// `http://127.0.0.1:10000/devstoreaccount1` (Azurite path-style).
    pub(super) base: Url,
    pub(super) auth: AzureAuth,
}

impl AzureClient {
    pub fn new(http: Client, account: String, base: Url, auth: AzureAuth) -> Self {
        Self {
            http,
            account,
            base,
            auth,
        }
    }

    pub(super) fn base_str(&self) -> &str {
        self.base.as_str().trim_end_matches('/')
    }

    /// Build a request URL from a relative path (container or container/blob)
    /// and query params, percent-encoding values correctly.
    pub(super) fn build(&self, rel_path: &str, query: &[(&str, &str)]) -> Url {
        let mut s = String::from(self.base_str());
        if !rel_path.is_empty() {
            s.push('/');
            s.push_str(rel_path);
        }
        let mut u = Url::parse(&s).expect("valid azure url");
        if !query.is_empty() {
            let mut qp = u.query_pairs_mut();
            for (k, v) in query {
                qp.append_pair(k, v);
            }
        }
        u
    }

    /// Compute the `Authorization: SharedKey ...` header value for a request.
    pub(super) fn sign(
        &self,
        key: &[u8],
        verb: &str,
        url: &Url,
        ms_headers: &[(String, String)],
        content_length: usize,
        content_type: &str,
    ) -> String {
        let mut ms: Vec<(String, String)> = ms_headers
            .iter()
            .filter(|(k, _)| k.starts_with("x-ms-"))
            .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_string()))
            .collect();
        ms.sort_by(|a, b| a.0.cmp(&b.0));
        let canon_headers: String = ms.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();

        let mut canon_resource = format!("/{}{}", self.account, url.path());
        let mut qp: Vec<(String, String)> = url
            .query_pairs()
            .map(|(k, v)| (k.to_ascii_lowercase(), v.into_owned()))
            .collect();
        qp.sort_by(|a, b| a.0.cmp(&b.0));
        for (k, v) in &qp {
            canon_resource.push_str(&format!("\n{k}:{v}"));
        }

        let cl = if content_length == 0 {
            String::new()
        } else {
            content_length.to_string()
        };
        // VERB, Content-Encoding, Content-Language, Content-Length, Content-MD5,
        // Content-Type, Date, If-Modified-Since, If-Match, If-None-Match,
        // If-Unmodified-Since, Range — Date is empty because x-ms-date is used.
        let head = [verb, "", "", &cl, "", content_type, "", "", "", "", "", ""].join("\n");
        let string_to_sign = format!("{head}\n{canon_headers}{canon_resource}");

        let mut mac = HmacSha256::new_from_slice(key).expect("hmac accepts any key length");
        mac.update(string_to_sign.as_bytes());
        let sig = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
        format!("SharedKey {}:{}", self.account, sig)
    }

    /// Execute a request with the configured auth (Shared Key signing, or SAS
    /// appended to the URL).
    pub(super) async fn send(
        &self,
        verb: reqwest::Method,
        url: Url,
        body: Option<Vec<u8>>,
        extra_ms_headers: &[(&str, &str)],
        content_type: Option<&str>,
    ) -> Result<reqwest::Response, String> {
        let date = chrono::Utc::now()
            .format("%a, %d %b %Y %H:%M:%S GMT")
            .to_string();
        let mut headers: Vec<(String, String)> = vec![
            ("x-ms-date".to_string(), date),
            ("x-ms-version".to_string(), MS_VERSION.to_string()),
        ];
        for (k, v) in extra_ms_headers {
            headers.push((k.to_string(), v.to_string()));
        }
        let content_length = body.as_ref().map(|b| b.len()).unwrap_or(0);

        let (final_url, sign) = match &self.auth {
            AzureAuth::Sas(sas) => {
                let sep = if url.query().is_some() { '&' } else { '?' };
                let u = Url::parse(&format!("{url}{sep}{sas}"))
                    .map_err(|e| format!("invalid SAS url: {e}"))?;
                (u, None)
            }
            AzureAuth::SharedKey(key) => {
                let auth = self.sign(
                    key,
                    verb.as_str(),
                    &url,
                    &headers,
                    content_length,
                    content_type.unwrap_or(""),
                );
                (url, Some(auth))
            }
            AzureAuth::Bearer(token) => (url, Some(format!("Bearer {token}"))),
        };

        let mut rb = self.http.request(verb, final_url);
        for (k, v) in &headers {
            rb = rb.header(k, v);
        }
        if let Some(ct) = content_type {
            rb = rb.header("content-type", ct);
        }
        if let Some(auth) = sign {
            rb = rb.header("authorization", auth);
        }
        // Azure's PutBlob requires an explicit Content-Length; reqwest omits it
        // for an empty body, so set it ourselves for any body-bearing request.
        if body.is_some() {
            rb = rb.header(reqwest::header::CONTENT_LENGTH, content_length.to_string());
        }
        if let Some(b) = body {
            rb = rb.body(b);
        }
        let resp = rb.send().await.map_err(net_err)?;
        check(resp).await
    }
}

impl AzureClient {
    pub async fn ping(&self, _default_location: Option<&str>) -> Result<(), String> {
        self.list_buckets().await.map(|_| ())
    }
}
