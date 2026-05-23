// Network-policy gate for full-local mode.
//
// When `AiConfig.full_local_mode` is true, every outbound network call from
// the AI subsystem must terminate at 127.0.0.1 / localhost. This module is
// the canonical predicate; routers, fetchers and search providers all call
// here so the rule has one place to change.

/// True when this URL points to loopback (127.0.0.1 / localhost / ::1).
pub fn is_local_url(url: &str) -> bool {
    if url.is_empty() {
        return true; // empty/in-process counts as local
    }
    if let Ok(parsed) = url::Url::parse(url) {
        match parsed.host_str() {
            Some("localhost") => true,
            Some(h) if h.starts_with("127.") => true,
            Some("::1") => true,
            Some("[::1]") => true,
            _ => false,
        }
    } else {
        false
    }
}

/// Refuse with a stable error string when full-local mode is on and the URL
/// would leave the box.
pub fn reject_if_remote(full_local: bool, url: &str) -> Result<(), String> {
    if full_local && !is_local_url(url) {
        Err("FULL_LOCAL_MODE: network call blocked".into())
    } else {
        Ok(())
    }
}

/// True when this LLM provider runtime is local-only (sidecar / in-process /
/// user-installed Ollama on loopback).
pub fn is_local_runtime(runtime: &str) -> bool {
    matches!(runtime, "llama-server" | "llama-cpp-2" | "ollama" | "in-process")
}
