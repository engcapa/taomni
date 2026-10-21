use super::session::DbHandle;
use super::session::get_session;
use crate::database::sql;
use crate::database::tx;
use crate::state::AppState;
use sqlx_mysql::MySql;
use sqlx_postgres::Postgres;
use tauri::State;

// ---------------------------------------------------------------------------
// Tauri commands — manual commit
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn db_tx_status(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<tx::DbTxStatus, String> {
    Ok(get_session(&state, &session_id).await?.tx_status())
}

#[tauri::command]
pub async fn db_tx_set_manual(
    state: State<'_, AppState>,
    session_id: String,
    manual: bool,
) -> Result<tx::DbTxStatus, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        // Switching autocommit back on commits the open transaction.
        DbHandle::MySql(pool) => {
            let sql = if manual {
                "SET autocommit=0"
            } else {
                "SET autocommit=1"
            };
            sql::exec_control_mysql(pool, sql).await?;
        }
        DbHandle::Postgres(pool) => {
            if !manual && session.tx.open() {
                sql::exec_control_postgres(pool, "COMMIT").await?;
            }
        }
        _ => return Err("Manual commit is not supported for this engine".into()),
    }
    session.tx.set_manual(manual);
    Ok(session.tx_status())
}

pub(super) async fn end_transaction(
    state: &State<'_, AppState>,
    session_id: &str,
    commit: bool,
) -> Result<tx::DbTxStatus, String> {
    let session = get_session(state, session_id).await?;
    let sql = if commit { "COMMIT" } else { "ROLLBACK" };
    match &session.handle {
        DbHandle::MySql(pool) => sql::exec_control_mysql(pool, sql).await?,
        DbHandle::Postgres(pool) => sql::exec_control_postgres(pool, sql).await?,
        _ => return Err("Manual commit is not supported for this engine".into()),
    }
    session.tx.reset();
    Ok(session.tx_status())
}

#[tauri::command]
pub async fn db_tx_commit(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<tx::DbTxStatus, String> {
    end_transaction(&state, &session_id, true).await
}

#[tauri::command]
pub async fn db_tx_rollback(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<tx::DbTxStatus, String> {
    end_transaction(&state, &session_id, false).await
}
