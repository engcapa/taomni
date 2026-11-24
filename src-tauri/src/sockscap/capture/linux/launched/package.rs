//! Verify and stage the Linux trace launcher from the signed SocksCap package.

use std::{
    cmp::Ordering,
    fs,
    io::ErrorKind,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::Arc,
};

use taomni_sockscap_api::SLUG;

use crate::plugin::{LifecycleState, PluginRegistry, verify::compare_versions};

const MINIMUM_LINUX_LAUNCHER_MODULE: &str = "0.1.13";
const RESOURCE_PATH: &str = "resources/linux/taomni-sockscap-trace-launcher";
const ELF_MAGIC: &[u8; 4] = b"\x7fELF";

pub(super) fn read_verified_launcher(
    registry: &PluginRegistry,
) -> Result<(String, Vec<u8>), String> {
    let record = registry.get(SLUG).ok_or_else(|| {
        "Install and enable the SocksCap module to use Linux application capture".to_string()
    })?;
    if record.state != LifecycleState::Enabled || record.reason.is_some() {
        return Err("Enable the SocksCap module before starting Linux application capture".into());
    }
    let version = record.manifest.version;
    if !supports_linux_launcher(&version) {
        return Err(format!(
            "Update the SocksCap module to {MINIMUM_LINUX_LAUNCHER_MODULE} or newer to use Linux application capture"
        ));
    }
    let bytes = registry
        .with_active_package(SLUG, &version, |trusted| trusted.read_file(RESOURCE_PATH))
        .map_err(|error| error.to_string())?;
    if !bytes.starts_with(ELF_MAGIC) {
        return Err("Signed SocksCap module contains an invalid Linux trace launcher".into());
    }
    Ok((version, bytes))
}

fn supports_linux_launcher(version: &str) -> bool {
    compare_versions(version, MINIMUM_LINUX_LAUNCHER_MODULE)
        .is_ok_and(|order| order != Ordering::Less)
}

pub(super) fn stage_launcher(registry: &PluginRegistry) -> Result<PathBuf, String> {
    let (version, bytes) = read_verified_launcher(registry)?;
    let mut directory = registry.root().to_path_buf();
    for segment in [SLUG, "runtime", "linux-capture", version.as_str()] {
        directory.push(segment);
        create_secure_directory(&directory)?;
    }
    let directory = fs::canonicalize(directory)
        .map_err(|error| format!("resolve SocksCap Linux capture directory: {error}"))?;
    super::preparation::materialize_launcher(&directory, &bytes)
}

pub(crate) async fn prepare(registry: &Arc<PluginRegistry>) -> Result<PathBuf, String> {
    let registry = registry.clone();
    tokio::task::spawn_blocking(move || stage_launcher(&registry))
        .await
        .map_err(|error| error.to_string())?
}

fn create_secure_directory(path: &Path) -> Result<(), String> {
    match fs::create_dir(path) {
        Ok(()) => (),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => (),
        Err(error) => {
            return Err(format!(
                "create SocksCap Linux capture directory {}: {error}",
                path.display()
            ));
        }
    }
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        format!(
            "inspect SocksCap Linux capture directory {}: {error}",
            path.display()
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "Invalid SocksCap Linux capture runtime directory: {}",
            path.display()
        ));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| {
        format!(
            "secure SocksCap Linux capture directory {}: {error}",
            path.display()
        )
    })
}

#[cfg(all(test, not(feature = "qa-release-trust-gates")))]
mod tests {
    use super::*;
    use crate::plugin::{
        ModuleManifest,
        verify::{host_platform, test_support},
    };
    use std::os::unix::fs::symlink;

    fn sockscap_manifest(version: &str) -> ModuleManifest {
        let mut manifest = test_support::manifest();
        manifest.id = "taomni-plugin-sockscap".into();
        manifest.slug = SLUG.into();
        manifest.name = "SocksCap".into();
        manifest.version = version.into();
        manifest.data_dir = format!("plugins/{SLUG}");
        manifest.platforms = [host_platform().to_owned()].into_iter().collect();
        manifest.entry.host = Some("taomni-plugin-sockscap".into());
        manifest.entry.frontend = None;
        manifest.backup_paths = vec![];
        manifest
    }

    fn install_sockscap(registry: &PluginRegistry, version: &str, launcher: &[u8]) {
        let package = test_support::verified_package_with_files(
            &sockscap_manifest(version),
            &[(RESOURCE_PATH, launcher)],
        );
        registry.install_verified(&package).unwrap();
    }

    #[test]
    fn requires_enabled_0_1_13_or_newer_module_with_elf_launcher() {
        let root = tempfile::tempdir().unwrap();
        let registry = PluginRegistry::new(root.path());
        assert!(read_verified_launcher(&registry).is_err());

        install_sockscap(
            &registry,
            "0.1.12",
            super::super::preparation::test_launcher_bytes(),
        );
        assert!(read_verified_launcher(&registry).is_err());
        registry.set_enabled(SLUG, true).unwrap();
        let outdated = read_verified_launcher(&registry).unwrap_err();
        assert!(outdated.contains("0.1.13"), "{outdated}");

        install_sockscap(&registry, "0.1.13", b"not-an-elf");
        registry.set_enabled(SLUG, true).unwrap();
        let invalid = read_verified_launcher(&registry).unwrap_err();
        assert!(
            invalid.contains("invalid Linux trace launcher"),
            "{invalid}"
        );
    }

    #[test]
    fn stages_verified_elf_idempotently_and_rejects_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let registry = PluginRegistry::new(root.path());
        let expected = super::super::preparation::test_launcher_bytes();
        install_sockscap(&registry, "0.1.13", expected);
        registry.set_enabled(SLUG, true).unwrap();

        let first = stage_launcher(&registry).unwrap();
        let second = stage_launcher(&registry).unwrap();
        assert_eq!(first, second);
        assert!(
            first.starts_with(
                fs::canonicalize(root.path())
                    .unwrap()
                    .join("sockscap/runtime/linux-capture/0.1.13")
            )
        );
        assert_eq!(fs::read(&first).unwrap(), expected);
        assert_eq!(
            fs::metadata(&first).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert!(super::super::preparation::preflight(None).is_err());
        if let Err(error) = super::super::preparation::preflight(Some(&registry)) {
            assert!(
                !error.contains("SocksCap module"),
                "verified launcher preflight failed at package lookup instead of kernel probe: {error}"
            );
        }

        let outside = root.path().join("outside");
        fs::create_dir(&outside).unwrap();
        let runtime_dir = root.path().join("sockscap/runtime");
        fs::remove_dir_all(&runtime_dir).unwrap();
        symlink(&outside, &runtime_dir).unwrap();
        assert!(stage_launcher(&registry).is_err());
    }
}
