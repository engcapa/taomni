use super::*;
use crate::proxy::{AppProxyConfig, ResolvedProxy};
use crate::vault::{ERR_VAULT_LOCKED, VaultStateKind};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCloneDefaults {
    pub git_available: bool,
    pub git_version: Option<String>,
    pub user_name: Option<String>,
    pub user_email: Option<String>,
    pub default_branch: String,
    pub clone_root: String,
    pub app_proxy_enabled: bool,
    /// Display-safe proxy URL without userinfo. Clone resolves the real value
    /// from Settings so proxy passwords never enter the renderer.
    pub app_proxy_url: Option<String>,
    pub app_proxy_error: Option<String>,
    /// "empty" | "locked" | "unlocked"
    pub vault_state: String,
    pub saved_token_available: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCloneProbeRequest {
    pub url: String,
    pub proxy_mode: String,
    pub http_proxy: Option<String>,
    pub https_proxy: Option<String>,
    pub token: Option<String>,
    pub token_username: Option<String>,
    pub use_saved_token: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCloneProbeResult {
    pub default_branch: Option<String>,
    pub head_oid: Option<String>,
    pub branches: Vec<String>,
}

fn git_available() -> (bool, Option<String>) {
    match run_git_strings(None, vec!["--version".to_string()]) {
        Ok(version) => (true, non_empty_string(&version)),
        Err(_) => (false, None),
    }
}

fn global_config(key: &str) -> Option<String> {
    run_git_strings(
        None,
        vec![
            "config".to_string(),
            "--global".to_string(),
            "--get".to_string(),
            key.to_string(),
        ],
    )
    .ok()
    .and_then(|value| non_empty_string(&value))
}

fn display_proxy(proxy: &ResolvedProxy) -> String {
    let scheme = if proxy.kind == "socks5" {
        "socks5"
    } else {
        "http"
    };
    format!("{scheme}://{}:{}", proxy.host, proxy.port)
}

fn resolve_app_proxy(
    state: &AppState,
) -> (bool, Option<String>, Option<String>, Option<ResolvedProxy>) {
    let config = AppProxyConfig::load(&crate::proxy::default_app_proxy_path());
    if !config.enabled {
        return (false, None, None, None);
    }
    match crate::proxy::resolve(state, &config) {
        Ok(Some(proxy)) => (true, Some(display_proxy(&proxy)), None, Some(proxy)),
        Ok(None) => (
            true,
            None,
            Some("Application proxy is enabled but not configured".to_string()),
            None,
        ),
        Err(error) => (true, None, Some(error), None),
    }
}

fn vault_state(state: &AppState) -> String {
    match state.vault.status() {
        Ok(status) => match status.state {
            VaultStateKind::Empty => "empty",
            VaultStateKind::Locked => "locked",
            VaultStateKind::Unlocked => "unlocked",
        }
        .to_string(),
        Err(_) => "locked".to_string(),
    }
}

pub(super) fn build_defaults(state: &AppState) -> Result<GitCloneDefaults, String> {
    let (git_ok, version) = git_available();
    let (app_proxy_enabled, app_proxy_url, app_proxy_error, _) = resolve_app_proxy(state);
    let vault_state = vault_state(state);
    let saved_token_available = vault_state == "unlocked"
        && state
            .vault
            .get_fixed(GIT_CLONE_TOKEN_ID)
            .map(|entry| entry.is_some())
            .unwrap_or(false);
    Ok(GitCloneDefaults {
        git_available: git_ok,
        git_version: version,
        user_name: global_config("user.name"),
        user_email: global_config("user.email"),
        default_branch: global_config("init.defaultBranch").unwrap_or_else(|| "main".into()),
        clone_root: dirs::home_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("taomni-workspaces")
            .to_string_lossy()
            .into_owned(),
        app_proxy_enabled,
        app_proxy_url,
        app_proxy_error,
        vault_state,
        saved_token_available,
    })
}

pub(super) fn resolve_proxy(
    state: &AppState,
    proxy_mode: &str,
    http_proxy: Option<&str>,
    https_proxy: Option<&str>,
) -> Result<(Option<String>, Option<String>), String> {
    match proxy_mode {
        "app" => {
            let (enabled, _display, error, resolved) = resolve_app_proxy(state);
            if !enabled {
                return Ok((None, None));
            }
            if let Some(error) = error {
                return Err(format!(
                    "Application proxy cannot be used: {error}. Configure Settings → Application Proxy or choose another proxy mode."
                ));
            }
            let Some(resolved) = resolved else {
                return Ok((None, None));
            };
            let url = resolved.to_url();
            Ok((Some(url.clone()), Some(url)))
        }
        "custom" => {
            let http = normalized_proxy(http_proxy)?;
            let https = normalized_proxy(https_proxy)?;
            if http.is_none() && https.is_none() {
                return Err("Custom proxy requires http.proxy or https.proxy".into());
            }
            Ok((http, https))
        }
        "none" => Ok((None, None)),
        other => Err(format!("Unknown proxy mode: {other}")),
    }
}

pub(super) fn resolve_token(
    state: &AppState,
    token: Option<&str>,
    token_username: Option<&str>,
    use_saved_token: bool,
) -> Result<Option<(String, Zeroizing<String>)>, String> {
    let username = token_username
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_TOKEN_USERNAME)
        .to_string();
    if let Some(token) = token.map(str::trim).filter(|value| !value.is_empty()) {
        if token.chars().any(char::is_control) {
            return Err("Token contains control characters".into());
        }
        return Ok(Some((username, Zeroizing::new(token.to_string()))));
    }
    if !use_saved_token {
        return Ok(None);
    }
    match state.vault.get_fixed(GIT_CLONE_TOKEN_ID) {
        Ok(Some(token)) => Ok(Some((username, token))),
        Ok(None) => Err("No saved Git token is available; enter a token".into()),
        Err(error) if error == ERR_VAULT_LOCKED => {
            Err("Unlock the vault to use the saved Git token".into())
        }
        Err(error) => Err(error),
    }
}

pub(super) fn network_command(
    proxy: &(Option<String>, Option<String>),
    token: Option<&(String, Zeroizing<String>)>,
) -> Result<(Command, Option<PathBuf>), String> {
    let mut command = new_git_command();
    apply_stable_locale(&mut command);
    command.env("GIT_TERMINAL_PROMPT", "0");
    command
        .arg("-c")
        .arg(format!("http.proxy={}", proxy.0.as_deref().unwrap_or("")));
    command
        .arg("-c")
        .arg(format!("https.proxy={}", proxy.1.as_deref().unwrap_or("")));
    let mut askpass = None;
    if let Some((username, password)) = token {
        command.arg("-c").arg("credential.helper=");
        let path = write_askpass_script()?;
        command.env("GIT_ASKPASS", path.as_os_str());
        command.env("TAOMNI_GIT_USERNAME", username);
        command.env("TAOMNI_GIT_PASSWORD", password.as_str());
        askpass = Some(path);
    }
    Ok((command, askpass))
}

pub(super) fn run_probe(
    url: &str,
    proxy: (Option<String>, Option<String>),
    token: Option<(String, Zeroizing<String>)>,
) -> Result<GitCloneProbeResult, String> {
    let (mut command, askpass) = network_command(&proxy, token.as_ref())?;
    command.current_dir(std::env::temp_dir());
    command.args(["ls-remote", "--symref", "--heads", "--", url]);
    let output = command
        .output()
        .map_err(|error| format!("failed to start git: {error}"));
    if let Some(askpass) = askpass {
        let _ = fs::remove_file(askpass);
    }
    let output = command_output(output?)?;
    let mut default_branch = None;
    let mut head_oid = None;
    let mut branches = Vec::new();
    for line in output.lines() {
        if let Some(reference) = line.strip_prefix("ref: ") {
            if let Some((target, name)) = reference.split_once('\t') {
                if name == "HEAD" {
                    default_branch = target
                        .strip_prefix("refs/heads/")
                        .and_then(non_empty_string);
                }
            }
            continue;
        }
        let Some((oid, name)) = line.split_once('\t') else {
            continue;
        };
        if name == "HEAD" {
            head_oid = non_empty_string(oid);
        } else if let Some(branch) = name.strip_prefix("refs/heads/") {
            if branches.len() < MAX_REMOTE_BRANCHES && !branch.is_empty() {
                branches.push(branch.to_string());
            }
        }
    }
    Ok(GitCloneProbeResult {
        default_branch,
        head_oid,
        branches,
    })
}

pub(super) fn prepare_probe(
    state: &AppState,
    request: GitCloneProbeRequest,
) -> Result<
    (
        String,
        (Option<String>, Option<String>),
        Option<(String, Zeroizing<String>)>,
    ),
    String,
> {
    let url = normalized_url(&request.url)?;
    let proxy = resolve_proxy(
        state,
        &request.proxy_mode,
        request.http_proxy.as_deref(),
        request.https_proxy.as_deref(),
    )?;
    let token = resolve_token(
        state,
        request.token.as_deref(),
        request.token_username.as_deref(),
        request.use_saved_token,
    )?;
    Ok((url, proxy, token))
}
