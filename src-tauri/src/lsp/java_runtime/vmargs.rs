use super::settings::get_configured_java_settings;
use crate::lsp::configuration_state::CONFIGURED_JAVA_VMARGS;
use crate::lsp::limits::DEFAULT_JDTLS_VMARGS;
use crate::lsp::presets::cmd;
use std::sync::Mutex as StdMutex;
use tokio::process::Command;

pub(in crate::lsp) fn configured_java_vmargs_lock() -> &'static StdMutex<Option<String>> {
    CONFIGURED_JAVA_VMARGS.get_or_init(|| StdMutex::new(None))
}

pub(in crate::lsp) fn set_configured_java_vmargs(vmargs: Option<&str>) {
    let normalized = vmargs
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if let Ok(mut guard) = configured_java_vmargs_lock().lock() {
        *guard = normalized;
    }
}

pub(in crate::lsp) fn get_configured_java_vmargs() -> Option<String> {
    configured_java_vmargs_lock()
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

/// Effective jdtls JVM args string (Settings override or default 1G heap).
pub(in crate::lsp) fn jdtls_vmargs_string() -> String {
    get_configured_java_vmargs().unwrap_or_else(|| DEFAULT_JDTLS_VMARGS.to_string())
}

/// Split JVM arg strings with simple shell-style quoting (spaces, "…", '…').
pub(in crate::lsp) fn split_jvm_args(raw: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for ch in raw.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        match ch {
            '"' | '\'' => quote = Some(ch),
            c if c.is_whitespace() => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }
    if !current.is_empty() {
        args.push(current);
    }
    args
}

pub(in crate::lsp) fn jdtls_vmargs() -> Vec<String> {
    let mut args = split_jvm_args(&jdtls_vmargs_string());
    if let Some(agent) = lombok_javaagent_arg() {
        args.push(agent);
    }
    args
}

/// Apply Settings JVM args as JAVA_OPTS for the jdtls wrapper (Linux/macOS).
/// Settings win over a parent-shell JAVA_OPTS so heap/GC overrides are not ignored.
/// Includes the Lombok `-javaagent` when configured so wrapper launches match the
/// direct-launch path.
pub(in crate::lsp) fn apply_jdtls_vmargs_to_command(cmd: &mut Command) {
    cmd.env("JAVA_OPTS", jdtls_vmargs().join(" "));
}

/// Lombok `-javaagent:<jar>` when Lombok is enabled with a configured jar path.
/// Short-term M6-A path (full bundle loading arrives with the jdtls bundle work).
pub(in crate::lsp) fn lombok_javaagent_arg() -> Option<String> {
    let settings = get_configured_java_settings();
    let jar = settings.lombok_jar_path.as_deref().map(str::trim)?;
    if !settings.lombok_enabled || jar.is_empty() {
        return None;
    }
    Some(format!("-javaagent:{jar}"))
}
