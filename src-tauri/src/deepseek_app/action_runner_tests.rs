use super::*;

#[test]
fn completed_results_offer_undo_only_for_a_durable_record() {
    let db = rusqlite::Connection::open_in_memory().unwrap();
    init_undo(&db).unwrap();
    for kind in ["file", "note"] {
        let id = format!("undo-{kind}");
        let mut result = output_value(&id, "completed", Instant::now(), "done".into(), Some(0));
        refresh_undo_availability(&db, &id, &mut result);
        assert_eq!(result["undoAvailable"], false);
        db.execute(
            "INSERT INTO tao_action_undo(action_id,kind,created_at) VALUES(?1,?2,0)",
            rusqlite::params![id, kind],
        )
        .unwrap();
        refresh_undo_availability(&db, &id, &mut result);
        assert_eq!(result["undoAvailable"], true);
        assert_eq!(result["actionId"], id);
        assert_eq!(result["output"], "done");

        // A cached execute response must not bring back an already consumed
        // Undo control, and legacy responses acquire the same current flag.
        let serialized = serde_json::to_string(&result).unwrap();
        let mut cached: Value = serde_json::from_str(&serialized).unwrap();
        db.execute("DELETE FROM tao_action_undo WHERE action_id=?1", [&id])
            .unwrap();
        refresh_undo_availability(&db, &id, &mut cached);
        assert_eq!(cached["undoAvailable"], false);
        cached.as_object_mut().unwrap().remove("undoAvailable");
        refresh_undo_availability(&db, &id, &mut cached);
        assert_eq!(cached["undoAvailable"], false);
    }
}

#[test]
fn results_without_a_verified_undo_table_never_offer_undo() {
    let db = rusqlite::Connection::open_in_memory().unwrap();
    let mut result = output_value("command", "completed", Instant::now(), "ok".into(), Some(0));
    refresh_undo_availability(&db, "command", &mut result);
    assert_eq!(result["undoAvailable"], false);
    assert_eq!(result["status"], "completed");
    assert_eq!(result["exitCode"], 0);
}

#[test]
fn repeated_file_replacement_keeps_exact_backup_and_our_published_hash() {
    let temp = tempfile::tempdir().unwrap();
    let mut previous = None;
    for round in 0..8 {
        let content = format!("# revision {round}\ndef add(a, b):\n    return a + b\n");
        let action: ActionProposal = serde_json::from_value(json!({"id":"repeated", "kind":"write_file", "title":"Update calculator", "target":{"workspacePath":temp.path()}, "payload":{"path":"calculator.py", "content":content}})).unwrap();
        let (path, backup, hash) = write_file(&action).unwrap();
        assert_eq!(backup, previous);
        assert_eq!(std::fs::read(&path).unwrap(), content.as_bytes());
        assert_eq!(hash, digest(content.as_bytes()));
        // A later external change must not become the expected Undo hash.
        std::fs::write(&path, "external update").unwrap();
        assert_ne!(hash, digest(std::fs::read(&path).unwrap()));
        previous = Some(b"external update".to_vec());
    }
}
