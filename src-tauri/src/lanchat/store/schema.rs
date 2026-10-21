use rusqlite::Connection;

/// Create all LanChat tables + indexes. Idempotent (`IF NOT EXISTS`).
pub(super) fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS profile (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            avatar      BLOB,
            avatar_hash TEXT,
            signature   TEXT NOT NULL DEFAULT '',
            status      TEXT NOT NULL DEFAULT 'online',
            updated_at  INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS peers (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            avatar_hash TEXT,
            signature   TEXT NOT NULL DEFAULT '',
            last_seen   INTEGER NOT NULL DEFAULT 0,
            status      TEXT NOT NULL DEFAULT 'offline'
        );
        CREATE TABLE IF NOT EXISTS groups (
            id         TEXT PRIMARY KEY,
            name       TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS group_members (
            group_id TEXT NOT NULL,
            node_id  TEXT NOT NULL,
            PRIMARY KEY (group_id, node_id)
        );
        CREATE TABLE IF NOT EXISTS conversations (
            id               TEXT PRIMARY KEY,
            kind             TEXT NOT NULL,
            peer_or_group_id TEXT NOT NULL,
            last_msg_at      INTEGER NOT NULL DEFAULT 0,
            unread           INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS messages (
            id         TEXT PRIMARY KEY,
            conv_id    TEXT NOT NULL,
            sender_id  TEXT NOT NULL,
            body       TEXT NOT NULL DEFAULT '',
            mentions   TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            state      TEXT NOT NULL DEFAULT 'sent'
        );
        CREATE INDEX IF NOT EXISTS idx_messages_conv_time
            ON messages (conv_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_conversations_last_msg
            ON conversations (last_msg_at);
        CREATE TABLE IF NOT EXISTS pinned_keys (
            node_id    TEXT PRIMARY KEY,
            cert_der   BLOB NOT NULL,
            first_seen INTEGER NOT NULL,
            last_seen  INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
            id              INTEGER PRIMARY KEY CHECK (id = 1),
            retention_days  INTEGER NOT NULL DEFAULT 90,
            max_per_conv    INTEGER NOT NULL DEFAULT 5000,
            cleanup_enabled INTEGER NOT NULL DEFAULT 1
        );
        INSERT OR IGNORE INTO settings (id) VALUES (1);
        ",
    )
}

/// Run forward-compatible schema migrations. Each ALTER TABLE ADD COLUMN
/// is individually executed and "duplicate column" errors are silently ignored
/// so the migration is safe to re-run on already-migrated databases.
pub(super) fn migrate_schema(conn: &Connection) {
    // v2: persist peer connection info for startup reconnection.
    // v3: persist this node's self-signed identity certificate (phase 1).
    // v4: at-rest message-body encryption (phase 3).
    // v5: "start LanChat on app launch" policy (single settings row).
    for ddl in [
        "ALTER TABLE peers ADD COLUMN addr TEXT",
        "ALTER TABLE peers ADD COLUMN port INTEGER",
        "ALTER TABLE profile ADD COLUMN cert_der BLOB",
        "ALTER TABLE messages ADD COLUMN body_cipher BLOB",
        "ALTER TABLE messages ADD COLUMN enc_ver INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE settings ADD COLUMN start_on_launch INTEGER NOT NULL DEFAULT 0",
    ] {
        if let Err(e) = conn.execute(ddl, []) {
            let msg = e.to_string();
            // "duplicate column name" is expected on re-runs; anything else is
            // worth logging but not fatal.
            if !msg.contains("duplicate column") {
                log::warn!("lanchat migrate: {ddl}: {e}");
            }
        }
    }
}
