//! Best-effort Windows DNS client cache → IP→hostname map (no elevation).

use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::sockscap::rules::dns_map::DnsMap;

/// Populate `map` from the system DNS cache.
///
/// Implementation: `Get-DnsClientCache` via PowerShell (works without admin on
/// modern Windows). Failures are silent — empty map is fine.
pub fn refresh_dns_client_cache(map: &Arc<Mutex<DnsMap>>) {
    #[cfg(windows)]
    {
        refresh_via_powershell(map);
    }
    #[cfg(not(windows))]
    {
        let _ = map;
    }
}

#[cfg(windows)]
fn refresh_via_powershell(map: &Arc<Mutex<DnsMap>>) {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    // EntryType 1 = A, 28 = AAAA in DnsClientCache.
    let script = r#"
Get-DnsClientCache -ErrorAction SilentlyContinue |
  Where-Object { $_.Type -eq 1 -or $_.Type -eq 28 -or $_.Type -eq 'A' -or $_.Type -eq 'AAAA' } |
  Select-Object -First 2000 Entry, Data |
  ForEach-Object { "{0}`t{1}" -f $_.Entry, $_.Data }
"#;

    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    let Ok(output) = output else {
        return;
    };
    if !output.status.success() {
        return;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let Ok(mut guard) = map.lock() else {
        return;
    };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some((host, data)) = line.split_once('\t') else {
            continue;
        };
        let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
        let data = data.trim();
        if host.is_empty() || data.is_empty() {
            continue;
        }
        if let Ok(ip) = data.parse::<IpAddr>() {
            guard.insert(ip, host, Some(Duration::from_secs(300)));
        }
    }
}

/// Spawn a background task that refreshes DNS cache every `interval`.
pub fn spawn_dns_cache_refresher(
    map: Arc<Mutex<DnsMap>>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    interval: Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::task::spawn_blocking(move || {
        // Immediate fill.
        refresh_dns_client_cache(&map);
        while !stop.load(std::sync::atomic::Ordering::SeqCst) {
            std::thread::sleep(interval);
            if stop.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            refresh_dns_client_cache(&map);
        }
    })
}
