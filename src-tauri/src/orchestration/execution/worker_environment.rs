//! Resource-scoped worker proxy/auth setup; inherited proxy variables never win.
use crate::orchestration::core::model::AgentResource;
use tauri::Manager;
use tokio::process::Command;

pub fn configure(
    app: &tauri::AppHandle,
    command: &mut Command,
    resource: &AgentResource,
    claude_native: bool,
) -> Result<(), String> {
    for name in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "NO_PROXY",
        "no_proxy",
    ] {
        command.env_remove(name);
    }
    let state = app.state::<crate::state::AppState>();
    let proxy =
        {
            let db = state.db.lock().map_err(|_| "DATABASE_UNAVAILABLE")?;
            match resource.proxy_mode.as_str() {
                "none" => None,
                "app" => crate::proxy::resolve_strict_with_db(
                    &crate::proxy::AppProxyConfig::load_strict(
                        &crate::proxy::default_app_proxy_path(),
                    )?,
                    Some(&db),
                    Some(&state.vault),
                )?
                .map(|p| p.to_url()),
                "custom" => crate::proxy::resolve_strict_with_db(
                    resource
                        .custom_proxy
                        .as_ref()
                        .ok_or("CUSTOM_PROXY_REQUIRED")?,
                    Some(&db),
                    Some(&state.vault),
                )?
                .map(|p| p.to_url()),
                _ => return Err("INVALID_PROXY".into()),
            }
        };
    if let Some(proxy) = proxy {
        for key in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ] {
            command.env(key, &proxy);
        }
    }
    // No implicit bypass of configured proxies, including loopback endpoints.
    command.env("NO_PROXY", "").env("no_proxy", "");
    command.env("TAOMNI_WORKER_PROXY_MODE", &resource.proxy_mode);
    command.env("TAOMNI_WORKER_HARNESS", &resource.harness);
    command.env("TAOMNI_WORKER_MODEL", &resource.model);
    command.env("TAOMNI_WORKER_BASE_URL", &resource.base_url);
    if claude_native && !resource.base_url.is_empty() {
        let base = resource.base_url.trim_end_matches('/');
        command.env(
            "ANTHROPIC_BASE_URL",
            base.strip_suffix("/v1").unwrap_or(base),
        );
    }
    if !resource.key_ref.is_empty() {
        let key = state
            .vault
            .resolve(&resource.key_ref)
            .map_err(|_| "VAULT_LOCKED")?
            .ok_or("VAULT_KEY_MISSING")?;
        command.env("TAOMNI_WORKER_API_KEY", key.to_string());
        if claude_native {
            command.env("ANTHROPIC_API_KEY", key.to_string());
        }
    }
    Ok(())
}
