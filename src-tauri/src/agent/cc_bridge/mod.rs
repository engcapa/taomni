// ⚠️ This module must NOT use crate::vault::*
// CC authentication is fully delegated to the CC CLI itself.

pub mod commands;
pub mod config;
pub mod process;
pub mod protocol;

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

pub const MIN_VERSION: &str = "1.0.0";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CcStatus {
    /// `claude` binary not found in PATH.
    NotFound,
    /// Found but version is below MIN_VERSION.
    VersionTooLow { found: String, required: String },
    /// Found + version OK, but `claude -p "ping"` failed (not logged in).
    NotAuthenticated,
    /// Ready to use.
    Ready { version: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CcStatusResult {
    pub status: CcStatus,
    pub message: String,
    pub binary_path: Option<String>,
}

/// Locate the `claude` binary. On Windows tries claude.cmd / claude.exe.
pub fn find_claude_binary() -> Option<String> {
    // Try explicit names in order.
    let candidates: &[&str] = if cfg!(windows) {
        &["claude.cmd", "claude.exe", "claude"]
    } else {
        &["claude"]
    };

    for name in candidates {
        if let Ok(path) = which::which(name) {
            return Some(path.to_string_lossy().to_string());
        }
    }
    None
}

/// Parse a semver string like "1.2.3" into (major, minor, patch).
fn parse_version(v: &str) -> Option<(u32, u32, u32)> {
    let v = v.trim().trim_start_matches('v');
    let parts: Vec<&str> = v.splitn(3, '.').collect();
    if parts.len() < 3 { return None; }
    Some((
        parts[0].parse().ok()?,
        parts[1].parse().ok()?,
        parts[2].split('-').next()?.parse().ok()?,
    ))
}

fn version_ok(found: &str, required: &str) -> bool {
    let (fmaj, fmin, fpat) = parse_version(found).unwrap_or((0, 0, 0));
    let (rmaj, rmin, rpat) = parse_version(required).unwrap_or((1, 0, 0));
    (fmaj, fmin, fpat) >= (rmaj, rmin, rpat)
}

/// Detect Claude Code CLI status.
pub async fn detect(binary: Option<&str>) -> CcStatusResult {
    let path = match binary {
        Some(b) if !b.is_empty() && b != "auto" => Some(b.to_string()),
        _ => find_claude_binary(),
    };

    let Some(bin) = path else {
        return CcStatusResult {
            status: CcStatus::NotFound,
            message: "Claude Code CLI not found. Install it to enable this feature.".into(),
            binary_path: None,
        };
    };

    // Run `claude --version`.
    let version_out = timeout(
        Duration::from_secs(5),
        Command::new(&bin).arg("--version").output(),
    ).await;

    let version_str = match version_out {
        Ok(Ok(out)) => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        _ => {
            return CcStatusResult {
                status: CcStatus::NotFound,
                message: format!("Failed to run `{} --version`", bin),
                binary_path: Some(bin),
            };
        }
    };

    // Extract version number (output is like "Claude Code 1.2.3" or just "1.2.3").
    let version = version_str.split_whitespace().last().unwrap_or("").to_string();

    if !version_ok(&version, MIN_VERSION) {
        return CcStatusResult {
            status: CcStatus::VersionTooLow {
                found: version.clone(),
                required: MIN_VERSION.into(),
            },
            message: format!("Claude Code {} found, but v{} or later is required.", version, MIN_VERSION),
            binary_path: Some(bin),
        };
    }

    // Probe authentication with a minimal non-interactive call.
    let auth_ok = probe_auth(&bin).await;

    if !auth_ok {
        return CcStatusResult {
            status: CcStatus::NotAuthenticated,
            message: "Claude Code is installed but not authenticated. Run `claude login` in a terminal.".into(),
            binary_path: Some(bin),
        };
    }

    CcStatusResult {
        status: CcStatus::Ready { version: version.clone() },
        message: format!("Claude Code v{} ready.", version),
        binary_path: Some(bin),
    }
}

/// Run a minimal probe to check authentication.
async fn probe_auth(binary: &str) -> bool {
    let result = timeout(
        Duration::from_secs(10),
        Command::new(binary)
            .args(["--print", "ping", "--output-format", "json"])
            .output(),
    ).await;

    match result {
        Ok(Ok(out)) => out.status.success(),
        _ => false,
    }
}
