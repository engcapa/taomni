use base64::Engine as _;
use hmac::Hmac;
use serde::Deserialize;
use sha2::Sha256;
use url::Url;

pub(super) type HmacSha256 = Hmac<Sha256>;

pub(super) const MS_VERSION: &str = "2021-12-02";

/// How a request is authorized.
pub enum AzureAuth {
    /// Shared Key: the decoded (raw) account key, HMAC-signed per request.
    SharedKey(Vec<u8>),
    /// A SAS token (query string, without the leading '?') appended to the URL.
    Sas(String),
    /// An Entra ID (Azure AD) OAuth2 access token, sent as `Authorization:
    /// Bearer`. Scoped to `https://storage.azure.com/`. Cannot mint a service
    /// SAS (that needs the account key or a user-delegation key), so `share_url`
    /// is unavailable under this auth.
    Bearer(String),
}

/// Derive the blob service base URL from account + optional explicit endpoint /
/// suffix. An explicit endpoint (e.g. Azurite's BlobEndpoint) wins.
pub fn azure_base_url(
    account: &str,
    endpoint: Option<&str>,
    endpoint_suffix: Option<&str>,
) -> Result<Url, String> {
    let raw = match endpoint.filter(|e| !e.is_empty()) {
        Some(e) => e.to_string(),
        None => {
            let suffix = endpoint_suffix
                .filter(|s| !s.is_empty())
                .unwrap_or("core.windows.net");
            format!("https://{account}.blob.{suffix}")
        }
    };
    Url::parse(raw.trim_end_matches('/')).map_err(|e| format!("invalid azure endpoint: {e}"))
}

/// Parse an Azure storage connection string into (account, base_url, auth).
pub fn parse_connection_string(cs: &str) -> Result<(String, Url, AzureAuth), String> {
    let mut account = None;
    let mut key = None;
    let mut sas = None;
    let mut blob_endpoint = None;
    let mut suffix = None;
    let mut protocol = "https";
    for part in cs.split(';') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let (k, v) = part.split_once('=').ok_or("malformed connection string")?;
        match k.trim().to_ascii_lowercase().as_str() {
            "accountname" => account = Some(v.trim().to_string()),
            "accountkey" => key = Some(v.trim().to_string()),
            "sharedaccesssignature" => sas = Some(v.trim().trim_start_matches('?').to_string()),
            "blobendpoint" => blob_endpoint = Some(v.trim().to_string()),
            "endpointsuffix" => suffix = Some(v.trim().to_string()),
            "defaultendpointsprotocol" => {
                protocol = if v.trim().eq_ignore_ascii_case("http") {
                    "http"
                } else {
                    "https"
                }
            }
            _ => {}
        }
    }
    let account = account.ok_or("connection string missing AccountName")?;
    let base = match blob_endpoint {
        Some(e) => {
            Url::parse(e.trim_end_matches('/')).map_err(|e| format!("invalid BlobEndpoint: {e}"))?
        }
        None => {
            let suffix = suffix.unwrap_or_else(|| "core.windows.net".into());
            Url::parse(&format!("{protocol}://{account}.blob.{suffix}"))
                .map_err(|e| format!("invalid derived endpoint: {e}"))?
        }
    };
    let auth = if let Some(sas) = sas {
        AzureAuth::Sas(sas)
    } else if let Some(k) = key {
        AzureAuth::SharedKey(decode_account_key(&k)?)
    } else {
        return Err("connection string needs AccountKey or SharedAccessSignature".into());
    };
    Ok((account, base, auth))
}

/// Base64-decode an account key into its raw bytes for HMAC signing.
pub fn decode_account_key(key: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(key.trim())
        .map_err(|e| format!("account key is not valid base64: {e}"))
}

/// Obtain an Entra ID (Azure AD) access token for the Blob service. A pasted
/// token wins; otherwise we shell out to the Azure CLI
/// (`az account get-access-token --resource https://storage.azure.com/`), which
/// uses whatever identity the user is signed into (`az login`). Requires `az`
/// on PATH. Dependency-free — no `azure_identity` SDK.
pub async fn acquire_bearer_token(pasted: Option<&str>) -> Result<String, String> {
    if let Some(t) = pasted.map(str::trim).filter(|t| !t.is_empty()) {
        return Ok(t.to_string());
    }
    let output = tokio::process::Command::new("az")
        .args([
            "account",
            "get-access-token",
            "--resource",
            "https://storage.azure.com/",
            "--output",
            "json",
        ])
        .output()
        .await
        .map_err(|e| {
            format!(
                "no access token provided and the Azure CLI (`az`) is not available to obtain \
                 one: {e}"
            )
        })?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "`az account get-access-token` failed (run `az login` first?): {}",
            err.trim()
        ));
    }
    #[derive(Deserialize)]
    struct Token {
        #[serde(rename = "accessToken")]
        access_token: String,
    }
    let token: Token = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("could not parse `az` token output: {e}"))?;
    if token.access_token.is_empty() {
        return Err("Azure CLI returned an empty access token".into());
    }
    Ok(token.access_token)
}
