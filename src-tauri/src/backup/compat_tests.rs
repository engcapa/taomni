//! Fixed archives from an independent encoder protect legacy restore contracts.
use super::{crypto, engine, manifest, restore};
use std::io::Read;

#[test]
fn fixed_plain_v1_v2_archives_inspect_and_restore_without_rewriting() {
    for (name, bytes, password) in [
        (
            "plain",
            include_bytes!("../../tests/fixtures/backup/legacy-plain.taobak").as_slice(),
            None,
        ),
        (
            "v1",
            include_bytes!("../../tests/fixtures/backup/legacy-v1.taobak").as_slice(),
            Some("compat-password"),
        ),
        (
            "v2",
            include_bytes!("../../tests/fixtures/backup/legacy-v2.taobak").as_slice(),
            Some("compat-password"),
        ),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join(format!("{name}.taobak"));
        std::fs::write(&archive, bytes).unwrap();
        let before = manifest::file_sha256(&archive).unwrap();
        let inspected = restore::inspect_archive(&archive, password).unwrap();
        assert_eq!(inspected.format_version, 1);
        assert!(inspected.provenance.is_none());
        assert_eq!(inspected.files.len(), 2);
        let data = temp.path().join("profile");
        restore::stage_restore_to_dir(&data, &archive, password).unwrap();
        restore::apply_pending_restore(&data).unwrap();
        let db = rusqlite::Connection::open(data.join("notes.db")).unwrap();
        let marker: String = db
            .query_row("SELECT value FROM legacy_marker", [], |r| r.get(0))
            .unwrap();
        assert_eq!(marker, "compatible");
        assert_eq!(
            std::fs::read_to_string(data.join("tunnels.json")).unwrap(),
            "{\"legacy\":\"compatible\"}"
        );
        assert_eq!(manifest::file_sha256(&archive).unwrap(), before);
        if password.is_some() {
            assert!(
                restore::inspect_archive(&archive, None)
                    .unwrap_err()
                    .contains("BACKUP_PASSWORD_REQUIRED")
            );
            assert!(
                restore::inspect_archive(&archive, Some("wrong"))
                    .unwrap_err()
                    .contains("BACKUP_BAD_PASSWORD")
            );
        }
    }
}

#[test]
fn new_archives_keep_version1_manifest_paths_and_envelopes() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("tunnels.json");
    std::fs::write(&config, b"{}").unwrap();
    for password in [None, Some("compat-password")] {
        let path = temp.path().join(if password.is_some() {
            "encrypted.taobak"
        } else {
            "plain.taobak"
        });
        engine::pack_staged_archive(
            &[engine::StagedFile {
                archive_path: "configs/tunnels.json".into(),
                disk_path: config.clone(),
            }],
            "test",
            "full",
            password,
            &path,
        )
        .unwrap();
        let bytes = std::fs::read(path).unwrap();
        let plain = if let Some(password) = password {
            assert!(bytes.starts_with(crypto::BACKUP_ENC_STREAM_MAGIC));
            crypto::decrypt_payload(&bytes, password).unwrap()
        } else {
            bytes
        };
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(plain)).unwrap();
        assert_eq!(zip.len(), 2);
        let mut text = String::new();
        zip.by_name("manifest.json")
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["formatVersion"], 1);
        assert_eq!(value["files"][0]["path"], "configs/tunnels.json");
        for local_only in [
            "settingsRevision",
            "rangeMode",
            "executionSource",
            "localRangeOverride",
        ] {
            assert!(value.get(local_only).is_none());
        }
        let mut old_zip = zip.by_name("configs/tunnels.json").unwrap();
        let mut data = String::new();
        old_zip.read_to_string(&mut data).unwrap();
        assert_eq!(data, "{}");
    }
}
