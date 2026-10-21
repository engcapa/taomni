use super::identity::avatar_fingerprint;
use super::lifetime::LanChatStore;
use super::model::LanMessage;
use super::model::RetentionSettings;
use super::model::direct_conv_id;
use crate::lanchat::protocol::PeerRecord;
use crate::lanchat::protocol::PresenceStatus;

#[test]
fn identity_is_stable_across_calls() {
    let store = LanChatStore::open_in_memory().unwrap();
    let a = store.ensure_identity().unwrap();
    let b = store.ensure_identity().unwrap();
    assert_eq!(a, b, "node id must be stable");
    assert!(!a.is_empty());
}

#[test]
fn default_profile_present_after_ensure() {
    let store = LanChatStore::open_in_memory().unwrap();
    let id = store.ensure_identity().unwrap();
    let p = store.get_profile().unwrap().expect("profile present");
    assert_eq!(p.id, id);
    assert!(!p.name.is_empty());
    assert_eq!(p.status, PresenceStatus::Online);
    assert!(p.avatar_base64.is_none());
}

#[test]
fn update_profile_changes_fields_and_avatar_fingerprint() {
    let store = LanChatStore::open_in_memory().unwrap();
    store.ensure_identity().unwrap();

    let p1 = store
        .update_profile(
            "赵敏",
            Some(b"img-one".to_vec()),
            "设计即沟通",
            PresenceStatus::Busy,
        )
        .unwrap();
    assert_eq!(p1.name, "赵敏");
    assert_eq!(p1.signature, "设计即沟通");
    assert_eq!(p1.status, PresenceStatus::Busy);
    let h1 = p1.avatar_hash.clone().expect("fingerprint set");
    assert_eq!(h1.len(), 16);

    // Different avatar content -> different fingerprint.
    let p2 = store
        .update_profile(
            "赵敏",
            Some(b"img-two".to_vec()),
            "设计即沟通",
            PresenceStatus::Busy,
        )
        .unwrap();
    assert_ne!(h1, p2.avatar_hash.unwrap(), "fingerprint tracks content");

    // None avatar -> keeps existing image + hash.
    let p3 = store
        .update_profile("林开发", None, "摸鱼中", PresenceStatus::Away)
        .unwrap();
    assert_eq!(p3.name, "林开发");
    assert!(
        p3.avatar_base64.is_some(),
        "avatar retained when None passed"
    );
}

#[test]
fn avatar_fingerprint_is_deterministic_16_hex() {
    let h = avatar_fingerprint(b"hello");
    assert_eq!(h.len(), 16);
    assert_eq!(h, avatar_fingerprint(b"hello"));
    assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
}

fn msg(id: &str, conv: &str, sender: &str, ts: i64, state: &str) -> LanMessage {
    LanMessage {
        id: id.into(),
        conv_id: conv.into(),
        sender_id: sender.into(),
        body: format!("body-{id}"),
        mentions: vec![],
        created_at: ts,
        state: state.into(),
    }
}

#[test]
fn insert_message_is_idempotent_on_id() {
    let store = LanChatStore::open_in_memory().unwrap();
    let conv = direct_conv_id("peer-x");
    store
        .ensure_conversation(&conv, "direct", "peer-x")
        .unwrap();
    assert!(
        store
            .insert_message(&msg("m1", &conv, "peer-x", 100, "delivered"))
            .unwrap()
    );
    // duplicate delivery -> not inserted again
    assert!(
        !store
            .insert_message(&msg("m1", &conv, "peer-x", 100, "delivered"))
            .unwrap()
    );
    assert_eq!(store.list_messages(&conv, 50).unwrap().len(), 1);
}

#[test]
fn messages_listed_oldest_first_within_limit() {
    let store = LanChatStore::open_in_memory().unwrap();
    let conv = direct_conv_id("peer-y");
    store
        .ensure_conversation(&conv, "direct", "peer-y")
        .unwrap();
    for (i, ts) in [(1, 300), (2, 100), (3, 200)] {
        store
            .insert_message(&msg(&format!("m{i}"), &conv, "me", ts, "sent"))
            .unwrap();
    }
    let got = store.list_messages(&conv, 2).unwrap();
    // last 2 by time (200, 300), returned oldest-first
    assert_eq!(got.len(), 2);
    assert_eq!(got[0].created_at, 200);
    assert_eq!(got[1].created_at, 300);
}

#[test]
fn conversation_unread_increments_and_resets() {
    let store = LanChatStore::open_in_memory().unwrap();
    let conv = direct_conv_id("peer-z");
    store
        .ensure_conversation(&conv, "direct", "peer-z")
        .unwrap();
    store.touch_conversation(&conv, 500, 1).unwrap();
    store.touch_conversation(&conv, 600, 1).unwrap();
    let c = store.get_conversation(&conv).unwrap().unwrap();
    assert_eq!(c.unread, 2);
    assert_eq!(c.last_msg_at, 600);
    store.reset_unread(&conv).unwrap();
    assert_eq!(store.get_conversation(&conv).unwrap().unwrap().unread, 0);
}

#[test]
fn message_state_transitions() {
    let store = LanChatStore::open_in_memory().unwrap();
    let conv = direct_conv_id("peer-s");
    store
        .ensure_conversation(&conv, "direct", "peer-s")
        .unwrap();
    store
        .insert_message(&msg("ms", &conv, "me", 1, "sending"))
        .unwrap();
    store.set_message_state("ms", "delivered").unwrap();
    assert_eq!(store.get_message("ms").unwrap().unwrap().state, "delivered");
}

#[test]
fn message_body_encrypted_at_rest_when_key_set() {
    let store = LanChatStore::open_in_memory().unwrap();
    store.set_message_key(&[7u8; 32]);
    let conv = direct_conv_id("peer-e");
    store
        .ensure_conversation(&conv, "direct", "peer-e")
        .unwrap();
    let mut m = msg("me1", &conv, "me", 10, "sent");
    m.body = "secret text".into();
    store.insert_message(&m).unwrap();

    // Round-trips through the decrypting read path.
    assert_eq!(
        store.get_message("me1").unwrap().unwrap().body,
        "secret text"
    );
    assert_eq!(
        store.list_messages(&conv, 10).unwrap()[0].body,
        "secret text"
    );

    // At rest the plaintext column is empty and the ciphertext is present.
    let conn = store.conn.lock().unwrap();
    let (plain, cipher, ev): (String, Option<Vec<u8>>, i64) = conn
        .query_row(
            "SELECT body, body_cipher, enc_ver FROM messages WHERE id = 'me1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(plain, "", "plaintext body not stored");
    assert!(cipher.is_some_and(|c| !c.is_empty()), "ciphertext stored");
    assert_eq!(ev, 1);
}

#[test]
fn migrate_message_encryption_encrypts_legacy_rows() {
    let store = LanChatStore::open_in_memory().unwrap();
    let conv = direct_conv_id("peer-m");
    store
        .ensure_conversation(&conv, "direct", "peer-m")
        .unwrap();
    // Insert without a key -> stored plaintext (enc_ver 0).
    let mut m = msg("ml1", &conv, "me", 5, "delivered");
    m.body = "legacy plaintext".into();
    store.insert_message(&m).unwrap();

    store.set_message_key(&[3u8; 32]);
    assert_eq!(store.migrate_message_encryption().unwrap(), 1);
    assert_eq!(
        store.get_message("ml1").unwrap().unwrap().body,
        "legacy plaintext"
    );
    let conn = store.conn.lock().unwrap();
    let (plain, ev): (String, i64) = conn
        .query_row(
            "SELECT body, enc_ver FROM messages WHERE id='ml1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(plain, "");
    assert_eq!(ev, 1);
}

#[test]
fn start_on_launch_defaults_off_and_persists() {
    let store = LanChatStore::open_in_memory().unwrap();
    // Fresh DB: opt-in policy is off by default.
    assert!(!store.get_start_on_launch().unwrap());
    store.set_start_on_launch(true).unwrap();
    assert!(store.get_start_on_launch().unwrap());
    store.set_start_on_launch(false).unwrap();
    assert!(!store.get_start_on_launch().unwrap());
}

#[test]
fn retention_trims_by_age_and_count() {
    let store = LanChatStore::open_in_memory().unwrap();
    let conv = direct_conv_id("peer-r");
    store
        .ensure_conversation(&conv, "direct", "peer-r")
        .unwrap();
    let now = chrono::Utc::now().timestamp_millis();
    let old = now - 100 * 86_400_000; // 100 days ago
    store
        .insert_message(&msg("old1", &conv, "me", old, "delivered"))
        .unwrap();
    for i in 0..5 {
        store
            .insert_message(&msg(&format!("r{i}"), &conv, "me", now - i, "delivered"))
            .unwrap();
    }
    store
        .set_retention(&RetentionSettings {
            retention_days: 90,
            max_per_conv: 3,
            cleanup_enabled: true,
        })
        .unwrap();
    let deleted = store.apply_retention().unwrap();
    assert!(deleted >= 1, "old + overflow rows deleted");
    let remaining = store.list_messages(&conv, 100).unwrap();
    assert!(remaining.len() <= 3, "trimmed to max_per_conv");
    assert!(
        !remaining.iter().any(|m| m.id == "old1"),
        "aged-out row gone"
    );
}

#[test]
fn clear_conversation_and_all_history() {
    let store = LanChatStore::open_in_memory().unwrap();
    let c1 = direct_conv_id("a");
    let c2 = direct_conv_id("b");
    store.ensure_conversation(&c1, "direct", "a").unwrap();
    store.ensure_conversation(&c2, "direct", "b").unwrap();
    store
        .insert_message(&msg("x1", &c1, "me", 1, "sent"))
        .unwrap();
    store
        .insert_message(&msg("y1", &c2, "me", 1, "sent"))
        .unwrap();
    store.clear_conversation(&c1).unwrap();
    assert_eq!(store.list_messages(&c1, 10).unwrap().len(), 0);
    assert_eq!(store.list_messages(&c2, 10).unwrap().len(), 1);
    store.clear_all_history().unwrap();
    assert_eq!(store.list_messages(&c2, 10).unwrap().len(), 0);
}

#[test]
fn group_membership_crud() {
    let store = LanChatStore::open_in_memory().unwrap();
    store.upsert_group("g1", "研发大群").unwrap();
    store.add_group_member("g1", "me").unwrap();
    store.add_group_member("g1", "zhao").unwrap();
    store.add_group_member("g1", "zhao").unwrap(); // idempotent
    let g = store.get_group("g1").unwrap().unwrap();
    assert_eq!(g.name, "研发大群");
    assert_eq!(g.members.len(), 2);
    store.remove_group_member("g1", "zhao").unwrap();
    assert_eq!(store.get_group("g1").unwrap().unwrap().members, vec!["me"]);
    // rename via upsert
    store.upsert_group("g1", "前端小队").unwrap();
    assert_eq!(store.get_group("g1").unwrap().unwrap().name, "前端小队");
    assert_eq!(store.list_groups().unwrap().len(), 1);
}

#[test]
fn list_recent_peers_returns_peers_with_addr_port() {
    let store = LanChatStore::open_in_memory().unwrap();
    let now = chrono::Utc::now().timestamp_millis();
    // Peer with addr+port (recent)
    store
        .store_peer(&PeerRecord {
            id: "p1".into(),
            name: "Alice".into(),
            avatar_hash: None,
            signature: String::new(),
            status: PresenceStatus::Online,
            last_seen: now,
            addr: Some("192.168.1.10".into()),
            port: Some(4711),
        })
        .unwrap();
    // Peer without addr (should be excluded)
    store
        .store_peer(&PeerRecord {
            id: "p2".into(),
            name: "Bob".into(),
            avatar_hash: None,
            signature: String::new(),
            status: PresenceStatus::Online,
            last_seen: now,
            addr: None,
            port: None,
        })
        .unwrap();
    let recent = store.list_recent_peers(60_000); // last minute
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0].id, "p1");
    assert_eq!(recent[0].addr.as_deref(), Some("192.168.1.10"));
    assert_eq!(recent[0].port, Some(4711));
}

#[test]
fn list_peers_keeps_cached_offline_names() {
    let store = LanChatStore::open_in_memory().unwrap();
    let now = chrono::Utc::now().timestamp_millis();
    store
        .store_peer(&PeerRecord {
            id: "peer-offline".into(),
            name: "周哲".into(),
            avatar_hash: None,
            signature: String::new(),
            status: PresenceStatus::Online,
            last_seen: now,
            addr: Some("192.168.1.55".into()),
            port: Some(4711),
        })
        .unwrap();
    store.mark_peer_offline("peer-offline").unwrap();

    let peers = store.list_peers().unwrap();
    assert_eq!(peers.len(), 1);
    assert_eq!(peers[0].name, "周哲");
    assert_eq!(peers[0].status, PresenceStatus::Offline);
}
