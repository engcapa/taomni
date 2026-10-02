//! Windows built-in Remote Desktop detection (design §4.1, DEC-05).
//!
//! Before Taomni starts its own RDP server on Windows, the settings UI asks
//! what the operating system already offers: whether this edition can host
//! Remote Desktop at all, whether it is enabled and the TermService is
//! running, which port it listens on, whether NLA is required and whether the
//! current user could enable it (administrator, possibly behind UAC).
//!
//! This module only *reads* system state and can open the system settings
//! page; it never changes the system configuration.

use serde::Serialize;

/// What the UI should recommend before starting Taomni's server.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Recommendation {
    /// Not Windows, or a Windows edition without a Remote Desktop host.
    Taomni,
    /// System Remote Desktop is enabled and running: use it directly.
    UseSystem,
    /// Supported but disabled, and the user can enable it (administrator).
    EnableSystem,
    /// Supported but disabled, and enabling it needs an administrator.
    NeedsAdmin,
    /// Detection failed; start Taomni without a prompt and log why.
    Unknown,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemRdpStatus {
    pub applicable: bool,
    pub supported: Option<bool>,
    pub edition: Option<String>,
    pub enabled: Option<bool>,
    pub service_running: Option<bool>,
    pub port: Option<u16>,
    pub port_in_use: Option<bool>,
    pub nla: Option<bool>,
    pub is_admin: Option<bool>,
    pub is_server: Option<bool>,
    pub recommendation: Option<Recommendation>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
}

/// Windows client editions without a Remote Desktop host ("Home").
pub(crate) fn edition_supports_rdp_host(edition_id: &str) -> Option<bool> {
    let id = edition_id.trim();
    if id.is_empty() {
        return None;
    }
    let lower = id.to_ascii_lowercase();
    if lower.starts_with("core") {
        // Core, CoreN, CoreSingleLanguage, CoreCountrySpecific = Home SKUs.
        return Some(false);
    }
    Some(true)
}

pub(crate) fn recommend(status: &SystemRdpStatus) -> Recommendation {
    if !status.applicable || status.supported == Some(false) {
        return Recommendation::Taomni;
    }
    match (status.enabled, status.service_running, status.is_admin) {
        (Some(true), Some(true), _) => Recommendation::UseSystem,
        (Some(false), _, Some(true)) => Recommendation::EnableSystem,
        (Some(false), _, Some(false)) => Recommendation::NeedsAdmin,
        // Enabled in the registry but the service is stopped behaves like a
        // disabled host from the user's point of view.
        (Some(true), Some(false), Some(true)) => Recommendation::EnableSystem,
        (Some(true), Some(false), Some(false)) => Recommendation::NeedsAdmin,
        _ => Recommendation::Unknown,
    }
}

/// Port Taomni should move to when the system host already owns `wanted`.
pub(crate) fn alternative_port(status: &SystemRdpStatus, wanted: u16) -> Option<u16> {
    let system_port = status.port.unwrap_or(3389);
    let effective = if wanted == 0 { 3389 } else { wanted };
    let system_listening = status.service_running == Some(true) && status.enabled == Some(true);
    (system_listening && effective == system_port)
        .then(|| if system_port == 3390 { 3391 } else { 3390 })
}

#[cfg(windows)]
mod imp {
    use super::SystemRdpStatus;
    use winreg::RegKey;
    use winreg::enums::HKEY_LOCAL_MACHINE;

    const TS_KEY: &str = r"SYSTEM\CurrentControlSet\Control\Terminal Server";
    const RDP_TCP_KEY: &str =
        r"SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp";
    const VERSION_KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";

    fn service_running(errors: &mut Vec<String>) -> Option<bool> {
        use windows::Win32::System::Services::{
            CloseServiceHandle, OpenSCManagerW, OpenServiceW, QueryServiceStatus,
            SC_MANAGER_CONNECT, SERVICE_QUERY_STATUS, SERVICE_RUNNING, SERVICE_STATUS,
        };
        use windows::core::w;
        // SAFETY: plain SCM queries with handles closed on every path.
        unsafe {
            let manager = match OpenSCManagerW(None, None, SC_MANAGER_CONNECT) {
                Ok(handle) => handle,
                Err(error) => {
                    errors.push(format!("OpenSCManager: {error}"));
                    return None;
                }
            };
            let result = match OpenServiceW(manager, w!("TermService"), SERVICE_QUERY_STATUS) {
                Ok(service) => {
                    let mut status = SERVICE_STATUS::default();
                    let running = match QueryServiceStatus(service, &mut status) {
                        Ok(()) => Some(status.dwCurrentState == SERVICE_RUNNING),
                        Err(error) => {
                            errors.push(format!("QueryServiceStatus: {error}"));
                            None
                        }
                    };
                    let _ = CloseServiceHandle(service);
                    running
                }
                // Missing service (stripped images) means no host.
                Err(_) => Some(false),
            };
            let _ = CloseServiceHandle(manager);
            result
        }
    }

    fn is_admin() -> Option<bool> {
        use windows::Win32::Foundation::{CloseHandle, HANDLE};
        use windows::Win32::Security::{
            GetTokenInformation, TOKEN_ELEVATION_TYPE, TOKEN_QUERY, TokenElevationType,
            TokenElevationTypeFull, TokenElevationTypeLimited,
        };
        use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
        use windows::Win32::UI::Shell::IsUserAnAdmin;
        // SAFETY: token query on the current process; handle closed below.
        unsafe {
            if IsUserAnAdmin().as_bool() {
                return Some(true);
            }
            let mut token = HANDLE::default();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
                return None;
            }
            let mut kind = TOKEN_ELEVATION_TYPE::default();
            let mut len = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenElevationType,
                Some(&mut kind as *mut _ as *mut core::ffi::c_void),
                std::mem::size_of::<TOKEN_ELEVATION_TYPE>() as u32,
                &mut len,
            )
            .is_ok();
            let _ = CloseHandle(token);
            // Limited = administrator behind UAC: can elevate to enable RDP.
            ok.then_some(kind == TokenElevationTypeLimited || kind == TokenElevationTypeFull)
        }
    }

    fn port_in_use(port: u16) -> bool {
        matches!(
            std::net::TcpListener::bind(("0.0.0.0", port)),
            Err(ref e) if e.kind() == std::io::ErrorKind::AddrInUse
                || e.kind() == std::io::ErrorKind::PermissionDenied
        )
    }

    pub fn probe() -> SystemRdpStatus {
        let mut status = SystemRdpStatus {
            applicable: true,
            ..SystemRdpStatus::default()
        };
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        match hklm.open_subkey(VERSION_KEY) {
            Ok(key) => {
                let edition: String = key.get_value("EditionID").unwrap_or_default();
                let installation: String = key.get_value("InstallationType").unwrap_or_default();
                status.supported = super::edition_supports_rdp_host(&edition);
                status.is_server = Some(
                    installation.eq_ignore_ascii_case("server")
                        || edition.to_ascii_lowercase().starts_with("server"),
                );
                status.edition = Some(edition).filter(|e| !e.is_empty());
            }
            Err(error) => status.errors.push(format!("edition: {error}")),
        }
        match hklm.open_subkey(TS_KEY) {
            Ok(key) => match key.get_value::<u32, _>("fDenyTSConnections") {
                Ok(deny) => status.enabled = Some(deny == 0),
                Err(error) => status.errors.push(format!("fDenyTSConnections: {error}")),
            },
            Err(error) => status.errors.push(format!("Terminal Server key: {error}")),
        }
        if let Ok(key) = hklm.open_subkey(RDP_TCP_KEY) {
            status.port = key
                .get_value::<u32, _>("PortNumber")
                .ok()
                .and_then(|p| u16::try_from(p).ok());
            status.nla = key
                .get_value::<u32, _>("UserAuthentication")
                .ok()
                .map(|v| v != 0);
        }
        status.service_running = service_running(&mut status.errors);
        status.is_admin = is_admin();
        let port = status.port.unwrap_or(3389);
        status.port_in_use = Some(port_in_use(port));
        status.recommendation = Some(super::recommend(&status));
        status
    }

    pub fn open_settings(is_server: bool) -> Result<(), String> {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut command = if is_server {
            std::process::Command::new("SystemPropertiesRemote.exe")
        } else {
            let mut command = std::process::Command::new("cmd");
            command.args(["/C", "start", "", "ms-settings:remotedesktop"]);
            command
        };
        command
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("failed to open Remote Desktop settings: {e}"))
    }
}

pub fn probe() -> SystemRdpStatus {
    #[cfg(windows)]
    {
        imp::probe()
    }
    #[cfg(not(windows))]
    {
        SystemRdpStatus {
            applicable: false,
            recommendation: Some(Recommendation::Taomni),
            ..SystemRdpStatus::default()
        }
    }
}

pub fn open_settings() -> Result<(), String> {
    #[cfg(windows)]
    {
        imp::open_settings(probe().is_server == Some(true))
    }
    #[cfg(not(windows))]
    {
        Err("system Remote Desktop settings exist only on Windows".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(
        enabled: Option<bool>,
        running: Option<bool>,
        admin: Option<bool>,
    ) -> SystemRdpStatus {
        SystemRdpStatus {
            applicable: true,
            supported: Some(true),
            enabled,
            service_running: running,
            is_admin: admin,
            port: Some(3389),
            ..SystemRdpStatus::default()
        }
    }

    #[test]
    fn home_editions_cannot_host() {
        for id in ["Core", "CoreN", "CoreSingleLanguage", "CoreCountrySpecific"] {
            assert_eq!(edition_supports_rdp_host(id), Some(false), "{id}");
        }
        for id in [
            "Professional",
            "Enterprise",
            "Education",
            "ServerDatacenter",
        ] {
            assert_eq!(edition_supports_rdp_host(id), Some(true), "{id}");
        }
        assert_eq!(edition_supports_rdp_host(""), None);
    }

    #[test]
    fn recommendations_follow_the_detected_state() {
        assert_eq!(
            recommend(&status(Some(true), Some(true), Some(false))),
            Recommendation::UseSystem
        );
        assert_eq!(
            recommend(&status(Some(false), Some(true), Some(true))),
            Recommendation::EnableSystem
        );
        assert_eq!(
            recommend(&status(Some(false), Some(false), Some(false))),
            Recommendation::NeedsAdmin
        );
        assert_eq!(
            recommend(&status(Some(true), Some(false), Some(true))),
            Recommendation::EnableSystem
        );
        assert_eq!(
            recommend(&status(None, None, None)),
            Recommendation::Unknown
        );
        let mut home = status(Some(false), Some(false), Some(true));
        home.supported = Some(false);
        assert_eq!(recommend(&home), Recommendation::Taomni);
        assert_eq!(
            recommend(&SystemRdpStatus::default()),
            Recommendation::Taomni
        );
    }

    #[test]
    fn port_moves_only_when_the_system_host_owns_it() {
        let running = status(Some(true), Some(true), Some(true));
        assert_eq!(alternative_port(&running, 3389), Some(3390));
        assert_eq!(alternative_port(&running, 0), Some(3390));
        assert_eq!(alternative_port(&running, 4000), None);
        let stopped = status(Some(false), Some(false), Some(true));
        assert_eq!(alternative_port(&stopped, 3389), None);
    }
}
