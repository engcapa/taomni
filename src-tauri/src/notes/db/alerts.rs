use super::identity::new_id;
use super::identity::now;
use super::model::NoteAlert;
use rusqlite::Connection;
use rusqlite::Result as SqlResult;
use rusqlite::params;

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

pub(super) fn kind_rank(kind: &str) -> i64 {
    match kind {
        "overdue" => 0,
        "reminder" => 1,
        "due_soon" => 2,
        _ => 3,
    }
}

/// Recompute the live alert set from note due/reminder times, reconcile it with
/// the persisted `note_alert_events` (so acknowledgements survive polling), and
/// return the current alerts ordered by severity then fire time.
pub fn list_alerts(
    conn: &Connection,
    now_ts: i64,
    due_soon_secs: i64,
) -> SqlResult<Vec<NoteAlert>> {
    // Desired = (note_id, kind, fire_at) tuples that currently qualify.
    let mut desired: Vec<(String, String, i64)> = Vec::new();

    // Overdue: past-due, incomplete, not archived.
    {
        let mut stmt = conn.prepare(
            "SELECT id, due_at FROM notes
             WHERE completed_at IS NULL AND archived_at IS NULL
               AND due_at IS NOT NULL AND due_at <= ?1",
        )?;
        let rows = stmt.query_map(params![now_ts], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (id, due) = row?;
            desired.push((id, "overdue".into(), due));
        }
    }
    // Due soon: within the window, still in the future.
    {
        let mut stmt = conn.prepare(
            "SELECT id, due_at FROM notes
             WHERE completed_at IS NULL AND archived_at IS NULL
               AND due_at IS NOT NULL AND due_at > ?1 AND due_at <= ?2",
        )?;
        let rows = stmt.query_map(params![now_ts, now_ts + due_soon_secs], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (id, due) = row?;
            desired.push((id, "due_soon".into(), due));
        }
    }
    // Reminder fired.
    {
        let mut stmt = conn.prepare(
            "SELECT id, reminder_at FROM notes
             WHERE completed_at IS NULL AND archived_at IS NULL
               AND reminder_at IS NOT NULL AND reminder_at <= ?1",
        )?;
        let rows = stmt.query_map(params![now_ts], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (id, rem) = row?;
            desired.push((id, "reminder".into(), rem));
        }
    }

    // Reconcile: drop events that no longer qualify, insert new pending ones,
    // refresh fire_at on the rest.
    let ts = now();
    let existing: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT note_id, kind FROM note_alert_events")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.collect::<SqlResult<Vec<_>>>()?
    };
    for (note_id, kind) in &existing {
        if !desired.iter().any(|(n, k, _)| n == note_id && k == kind) {
            conn.execute(
                "DELETE FROM note_alert_events WHERE note_id = ?1 AND kind = ?2",
                params![note_id, kind],
            )?;
        }
    }
    for (note_id, kind, fire_at) in &desired {
        conn.execute(
            "INSERT INTO note_alert_events
                (id, note_id, kind, state, fire_at, acknowledged_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'pending', ?4, NULL, ?5, ?5)
             ON CONFLICT(note_id, kind) DO UPDATE SET fire_at = ?4, updated_at = ?5",
            params![new_id(), note_id, kind, fire_at, ts],
        )?;
    }

    // Return joined with note info.
    let mut stmt = conn.prepare(
        "SELECT e.id, e.note_id, e.kind, e.state, e.fire_at, e.acknowledged_at,
                n.title, n.due_at, n.reminder_at
         FROM note_alert_events e JOIN notes n ON n.id = e.note_id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(NoteAlert {
            id: r.get(0)?,
            note_id: r.get(1)?,
            kind: r.get(2)?,
            state: r.get(3)?,
            fire_at: r.get(4)?,
            acknowledged_at: r.get(5)?,
            note_title: r.get(6)?,
            due_at: r.get(7)?,
            reminder_at: r.get(8)?,
        })
    })?;
    let mut alerts: Vec<NoteAlert> = rows.collect::<SqlResult<Vec<_>>>()?;
    alerts.sort_by(|a, b| {
        kind_rank(&a.kind)
            .cmp(&kind_rank(&b.kind))
            .then(a.fire_at.cmp(&b.fire_at))
    });
    Ok(alerts)
}

/// Mark an alert event acknowledged (so it stops badging the Tao Ribbon).
pub fn ack_alert(conn: &Connection, id: &str) -> SqlResult<()> {
    let ts = now();
    conn.execute(
        "UPDATE note_alert_events SET state = 'acknowledged', acknowledged_at = ?1, updated_at = ?1
         WHERE id = ?2",
        params![ts, id],
    )?;
    Ok(())
}
