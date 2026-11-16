//! Validated archive names and their fixed restore destinations.
use std::path::{Path, PathBuf};

pub(super) fn checked_path(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.contains('\\')
        || name.contains(':')
        || name.starts_with('/')
        || name.split('/').any(|p| {
            p.is_empty()
                || p == "."
                || p == ".."
                || p.ends_with('.')
                || p.ends_with(' ')
                || p.chars().any(|c| c.is_control())
        })
    {
        return Err(format!("Unsafe backup path: {name}"));
    }
    for part in name.split('/') {
        let base = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if ["CON", "PRN", "AUX", "NUL"].contains(&base.as_str())
            || (base.len() == 4
                && (base.starts_with("COM") || base.starts_with("LPT"))
                && base.as_bytes()[3].is_ascii_digit())
        {
            return Err("Reserved backup path".into());
        }
    }
    Ok(())
}

fn valid_mail_object_path(name: &str) -> bool {
    let parts: Vec<_> = name.split('/').collect();
    parts.len() == 5
        && parts[0] == "mail-cache"
        && parts[1].ends_with(".mail")
        && parts[2] == "objects"
        && parts[3].len() == 2
        && parts[4].strip_suffix(".eml.gz").is_some_and(|hash| {
            hash.len() == 64
                && hash.starts_with(parts[3])
                && hash
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        })
}
fn valid_mail_attachment_path(name: &str) -> bool {
    let parts: Vec<_> = name.split('/').collect();
    parts.len() == 5
        && parts[0] == "mail-cache"
        && parts[1] == "attachments"
        && parts[4].ends_with(".bin")
}

pub(super) fn destination(
    app_data: &Path,
    manifest: &super::super::manifest::BackupManifest,
    name: &str,
) -> Result<PathBuf, String> {
    checked_path(name)?;
    if let Some(target) = super::super::plugins::restore::destination(app_data, manifest, name)? {
        return Ok(target);
    }
    let target = match name {
        "databases/taomni.db" => app_data.join("taomni.db"),
        "databases/notes.db" => app_data.join("notes.db"),
        "databases/vault.db" => app_data.join("vault.db"),
        "databases/mfa.db" => app_data.join("mfa.db"),
        "configs/tunnels.json" => app_data.join("tunnels.json"),
        "configs/ai.json" | "configs/proxy.json" | "configs/mirror.json" | "configs/sdk.json" => {
            crate::resolved_config_dir()
                .ok_or("Configuration directory unavailable")?
                .join("taomni")
                .join(name.strip_prefix("configs/").unwrap())
        }
        "servers/ssh_host_ed25519" => app_data.join("ssh-server/host_ed25519"),
        "servers/rdp_cert.pem" => app_data.join("rdp-server/cert.pem"),
        "servers/rdp_key.pem" => app_data.join("rdp-server/key.pem"),
        "local-history/history.db" => app_data.join(name),
        _ if name.starts_with("mail-cache/")
            && name.ends_with(".db")
            && name.split('/').count() == 2 =>
        {
            app_data.join(name)
        }
        _ if valid_mail_object_path(name) || valid_mail_attachment_path(name) => {
            app_data.join(name)
        }
        _ => return Err(format!("Unsupported Taomni backup entry: {name}")),
    };
    Ok(target)
}

pub(super) fn no_symlink_ancestors(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        match std::fs::symlink_metadata(ancestor) {
            Ok(metadata) if crate::plugin::data_contract::is_link(&metadata) => {
                return Err("Restore destination contains a symlink/reparse point".into());
            }
            Err(error)
                if !matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                return Err(error.to_string());
            }
            _ => (),
        }
    }
    Ok(())
}
