use super::manager::SdkManager;
use super::model::SaveSdkInstallationRequest;
use super::model::SaveWorkspaceSdkBindingRequest;
use super::model::SdkBindingMode;
use super::model::SdkInstallation;
use super::model::SdkKind;
use super::model::SdkOrigin;
use super::model::SdkRegistry;
use super::model::SdkRole;
use super::model::SdkStatus;
use super::model::SetSdkDefaultRequest;
use super::model::WorkspaceSdkBinding;
use super::persistence::normalize_registry_paths;
use super::persistence::strip_verbatim_prefix;
use std::collections::BTreeMap;
use std::path::Path;

fn missing_request(kind: SdkKind, name: &str, location: &Path) -> SaveSdkInstallationRequest {
    SaveSdkInstallationRequest {
        id: None,
        kind,
        name: Some(name.to_string()),
        location: location.to_string_lossy().into_owned(),
        origin: None,
    }
}

#[test]
fn registry_serializes_stable_camel_case_contract() {
    let registry = SdkRegistry {
        bindings: vec![WorkspaceSdkBinding {
            scope_path: "C:/repo".into(),
            kind: SdkKind::Java,
            role: SdkRole::Project,
            mode: SdkBindingMode::Auto,
            sdk_id: None,
            updated_at: "2026-01-01T00:00:00Z".into(),
        }],
        ..SdkRegistry::default()
    };
    let value = serde_json::to_value(registry).unwrap();
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["bindings"][0]["scopePath"], "C:/repo");
    assert_eq!(value["bindings"][0]["kind"], "java");
    assert_eq!(value["bindings"][0]["role"], "project");
}

#[tokio::test]
async fn manager_persists_multiple_installations_and_defaults() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("sdk.json");
    let manager = SdkManager::load(path.clone());
    let java = manager
        .save_installation(missing_request(
            SdkKind::Java,
            "JDK 17",
            &directory.path().join("jdk-17"),
        ))
        .await
        .unwrap();
    let java_21 = manager
        .save_installation(missing_request(
            SdkKind::Java,
            "JDK 21",
            &directory.path().join("jdk-21"),
        ))
        .await
        .unwrap();
    let kotlin = manager
        .save_installation(missing_request(
            SdkKind::Kotlin,
            "Kotlin CLI",
            &directory.path().join("kotlin"),
        ))
        .await
        .unwrap();
    assert_eq!(java.status, SdkStatus::Missing);
    manager
        .set_default(SetSdkDefaultRequest {
            kind: SdkKind::Java,
            sdk_id: Some(java_21.id.clone()),
        })
        .await
        .unwrap();
    manager
        .save_binding(SaveWorkspaceSdkBindingRequest {
            scope_path: directory.path().to_string_lossy().into_owned(),
            kind: SdkKind::Kotlin,
            role: SdkRole::Compiler,
            mode: SdkBindingMode::Manual,
            sdk_id: Some(kotlin.id.clone()),
        })
        .await
        .unwrap();

    let reloaded = SdkManager::load(path).snapshot().await;
    assert_eq!(reloaded.installations.len(), 3);
    assert_eq!(reloaded.defaults[0].sdk_id, java_21.id);
    assert_eq!(
        reloaded.bindings[0].sdk_id.as_deref(),
        Some(kotlin.id.as_str())
    );
    assert_ne!(java.id, java_21.id);
}

#[tokio::test]
async fn removing_installation_cleans_references() {
    let directory = tempfile::tempdir().unwrap();
    let manager = SdkManager::load(directory.path().join("sdk.json"));
    let java = manager
        .save_installation(missing_request(
            SdkKind::Java,
            "JDK",
            &directory.path().join("jdk"),
        ))
        .await
        .unwrap();
    manager
        .set_default(SetSdkDefaultRequest {
            kind: SdkKind::Java,
            sdk_id: Some(java.id.clone()),
        })
        .await
        .unwrap();
    manager
        .save_binding(SaveWorkspaceSdkBindingRequest {
            scope_path: directory.path().to_string_lossy().into_owned(),
            kind: SdkKind::Java,
            role: SdkRole::Project,
            mode: SdkBindingMode::Manual,
            sdk_id: Some(java.id.clone()),
        })
        .await
        .unwrap();

    manager.remove_installation(&java.id).await.unwrap();
    let registry = manager.snapshot().await;
    assert!(registry.installations.is_empty());
    assert!(registry.defaults.is_empty());
    assert!(registry.bindings.is_empty());
}

#[test]
fn strip_verbatim_prefix_cleans_windows_extended_paths() {
    assert_eq!(
        strip_verbatim_prefix(r"\\?\C:\Program Files\Java\jdk-21"),
        r"C:\Program Files\Java\jdk-21"
    );
    assert_eq!(strip_verbatim_prefix(r"//?/C:/Tools/jdk"), "C:/Tools/jdk");
    // UNC verbatim paths fold back to the `\\server\share` form.
    assert_eq!(
        strip_verbatim_prefix(r"\\?\UNC\server\share\jdk"),
        r"\\server\share\jdk"
    );
    // Already-clean paths (and all Unix paths) pass through untouched.
    assert_eq!(
        strip_verbatim_prefix(r"C:\Program Files\Java\jdk-21"),
        r"C:\Program Files\Java\jdk-21"
    );
    assert_eq!(
        strip_verbatim_prefix("/usr/lib/jvm/jdk-21"),
        "/usr/lib/jvm/jdk-21"
    );
}

#[test]
fn normalize_registry_paths_heals_verbatim_locations_on_load() {
    let mut registry = SdkRegistry {
        installations: vec![SdkInstallation {
            id: "jdk-21".into(),
            kind: SdkKind::Java,
            name: "java21".into(),
            location: r"\\?\C:\Program Files\Java\jdk-21".into(),
            executables: BTreeMap::from([(
                "java".to_string(),
                r"\\?\C:\Program Files\Java\jdk-21\bin\java.exe".to_string(),
            )]),
            version: Some("21.0.4".into()),
            vendor: None,
            architecture: None,
            origin: SdkOrigin::Manual,
            status: SdkStatus::Ready,
            last_error: None,
            last_probed_at: None,
        }],
        bindings: vec![WorkspaceSdkBinding {
            scope_path: r"\\?\D:\code\ads\ique".into(),
            kind: SdkKind::Java,
            role: SdkRole::Project,
            mode: SdkBindingMode::Manual,
            sdk_id: Some("jdk-21".into()),
            updated_at: "now".into(),
        }],
        ..SdkRegistry::default()
    };

    normalize_registry_paths(&mut registry);

    assert_eq!(
        registry.installations[0].location,
        r"C:\Program Files\Java\jdk-21"
    );
    assert_eq!(
        registry.installations[0].executables.get("java").unwrap(),
        r"C:\Program Files\Java\jdk-21\bin\java.exe"
    );
    assert_eq!(registry.bindings[0].scope_path, r"D:\code\ads\ique");
}

#[tokio::test]
async fn manual_binding_requires_matching_installation() {
    let directory = tempfile::tempdir().unwrap();
    let manager = SdkManager::load(directory.path().join("sdk.json"));
    let error = manager
        .save_binding(SaveWorkspaceSdkBindingRequest {
            scope_path: directory.path().to_string_lossy().into_owned(),
            kind: SdkKind::Python,
            role: SdkRole::Project,
            mode: SdkBindingMode::Manual,
            sdk_id: None,
        })
        .await
        .unwrap_err();
    assert!(error.contains("requires"));
}
