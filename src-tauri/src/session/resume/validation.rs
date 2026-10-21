use super::model::SnapshotEntry;
use crate::terminal::local_directories::normalize_path_key;

/// Saved-session types the Welcome restore can actually reopen (design
/// §4.2.2). Browser / external files / unknown types are never collected.
pub fn is_recoverable_saved_session_type(session_type: &str) -> bool {
    matches!(
        session_type,
        "LocalShell"
            | "SSH"
            | "SFTP"
            | "RDP"
            | "VNC"
            | "MySQL"
            | "PostgreSQL"
            | "PanWeiDB"
            | "Oracle"
            | "SQLServer"
            | "StarRocks"
            | "ClickHouse"
            | "Presto"
            | "Redis"
            | "HBaseShell"
            | "Proxy"
            | "S3"
            | "AzureBlob"
            | "File"
            | "Mail"
            | "FTP"
            | "Telnet"
            | "Rlogin"
            | "Mosh"
            | "Serial"
    )
}

/// Validate one entry's basic integrity; identity is generated when absent.
pub(super) fn validate_entry(entry: &mut SnapshotEntry) -> Result<(), String> {
    match entry {
        SnapshotEntry::SavedSession {
            identity,
            saved_session_id,
            saved_session_type,
            display_name,
        } => {
            if saved_session_id.trim().is_empty() {
                return Err("saved-session entry requires savedSessionId".to_string());
            }
            if saved_session_type.trim().is_empty() {
                return Err("saved-session entry requires savedSessionType".to_string());
            }
            if display_name.trim().is_empty() {
                *display_name = saved_session_id.clone();
            }
            if identity.trim().is_empty() {
                *identity = format!("saved:{saved_session_id}");
            }
        }
        SnapshotEntry::LocalTerminal {
            identity,
            display_name,
            shell_id,
            shell_args,
            confirmed_cwd,
        } => {
            if shell_id.trim().is_empty() {
                return Err("local-terminal entry requires shellId".to_string());
            }
            if confirmed_cwd.trim().is_empty() {
                return Err("local-terminal entry requires confirmedCwd".to_string());
            }
            // Only confirmed native cwd values enter the whitelist.
            if normalize_path_key(std::path::Path::new(confirmed_cwd)).is_none() {
                return Err(format!(
                    "local-terminal confirmedCwd is not a valid native absolute path: {confirmed_cwd}"
                ));
            }
            if display_name.trim().is_empty() {
                *display_name = confirmed_cwd.clone();
            }
            if identity.trim().is_empty() {
                *identity = format!("local:{}", uuid::Uuid::new_v4().simple());
            }
            let _ = shell_args;
        }
    }
    Ok(())
}
