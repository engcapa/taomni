//! Built-in Tao workflows and durable step checkpoints.
use crate::state::AppState;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use tauri::State;

fn init(db: &Connection) -> Result<(), String> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS tao_workflow_runs(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,definition_id TEXT NOT NULL,status TEXT NOT NULL,current_step INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS tao_workflow_steps(run_id TEXT NOT NULL,step_index INTEGER NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,result TEXT,PRIMARY KEY(run_id,step_index));").map_err(|e|e.to_string())
}
pub fn definitions() -> Vec<Value> {
    vec![
        (
            "deep_research",
            "深研",
            vec!["搜索", "读链接", "交叉验证", "结构化报告"],
        ),
        (
            "code_review",
            "代码 review",
            vec!["读文件", "跑测试 / 静态检查", "出报告"],
        ),
        (
            "sql_investigate",
            "SQL 排查",
            vec!["看表结构", "写 SQL", "确认后执行", "汇总"],
        ),
        (
            "troubleshoot",
            "故障排查",
            vec!["读终端日志", "定位", "给修复命令", "验证"],
        ),
        (
            "file_organize",
            "文件整理",
            vec!["扫描", "分类计划", "确认", "执行"],
        ),
    ]
    .into_iter()
    .map(|(id, title, steps)| json!({"id":id,"title":title,"steps":steps,"builtIn":true}))
    .collect()
}
pub fn list_runs(db: &Connection, thread: Option<&str>) -> Result<Vec<Value>, String> {
    init(db)?;
    let sql = if thread.is_some() {
        "SELECT id,thread_id,definition_id,status,current_step,created_at,updated_at FROM tao_workflow_runs WHERE thread_id=?1 ORDER BY updated_at DESC"
    } else {
        "SELECT id,thread_id,definition_id,status,current_step,created_at,updated_at FROM tao_workflow_runs ORDER BY updated_at DESC"
    };
    let mut s = db.prepare(sql).map_err(|e| e.to_string())?;
    if let Some(t) = thread {
        let rows = s.query_map([t], row).map_err(|e| e.to_string())?;
        return rows.map(|r| r.map_err(|e| e.to_string())).collect();
    }
    let rows = s.query_map([], row).map_err(|e| e.to_string())?;
    rows.map(|r| r.map_err(|e| e.to_string())).collect()
}
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"id":r.get::<_,String>(0)?,"threadId":r.get::<_,String>(1)?,"definitionId":r.get::<_,String>(2)?,"status":r.get::<_,String>(3)?,"currentStep":r.get::<_,i64>(4)?,"createdAt":r.get::<_,i64>(5)?,"updatedAt":r.get::<_,i64>(6)?}),
    )
}
#[tauri::command]
pub fn deepseek_app_workflows() -> Vec<Value> {
    definitions()
}
#[tauri::command]
pub fn deepseek_app_create_workflow(
    thread_id: String,
    definition_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let db = state.core.db.lock().map_err(|_| "database unavailable")?;
    init(&db)?;
    let def = definitions()
        .into_iter()
        .find(|d| d["id"] == definition_id)
        .ok_or("workflow: unknown built-in")?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = crate::deepseek_app::store::now();
    db.execute(
        "INSERT INTO tao_workflow_runs VALUES(?1,?2,?3,'pending',0,?4,?4)",
        params![id, thread_id, definition_id, now],
    )
    .map_err(|e| e.to_string())?;
    for (i, title) in def["steps"].as_array().unwrap().iter().enumerate() {
        db.execute(
            "INSERT INTO tao_workflow_steps VALUES(?1,?2,?3,'pending',NULL)",
            params![id, i as i64, title.as_str().unwrap()],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(
        json!({"id":id,"threadId":thread_id,"definitionId":definition_id,"status":"pending","currentStep":0}),
    )
}
#[tauri::command]
pub fn deepseek_app_workflow_runs(
    thread_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<Value>, String> {
    let db = state.core.db.lock().map_err(|_| "database unavailable")?;
    list_runs(&db, thread_id.as_deref())
}
#[tauri::command]
pub fn deepseek_app_advance_workflow(
    run_id: String,
    confirmed: bool,
    skip: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    if !confirmed {
        return Err("confirmation: workflow step requires approval".into());
    }
    let db = state.core.db.lock().map_err(|_| "database unavailable")?;
    init(&db)?;
    let (index, status): (i64, String) = db
        .query_row(
            "SELECT current_step,status FROM tao_workflow_runs WHERE id=?1",
            [&run_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| "workflow: run not found")?;
    if matches!(status.as_str(), "done" | "cancelled") {
        return Err("workflow: run is no longer active".into());
    }
    let new_status = if skip.unwrap_or(false) {
        "skipped"
    } else {
        "completed"
    };
    db.execute(
        "UPDATE tao_workflow_steps SET status=?3 WHERE run_id=?1 AND step_index=?2",
        params![run_id, index, new_status],
    )
    .map_err(|e| e.to_string())?;
    let count: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM tao_workflow_steps WHERE run_id=?1",
            [&run_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let next = index + 1;
    let overall = if next >= count { "done" } else { "running" };
    db.execute(
        "UPDATE tao_workflow_runs SET status=?2,current_step=?3,updated_at=?4 WHERE id=?1",
        params![run_id, overall, next, crate::deepseek_app::store::now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(json!({"id":run_id,"status":overall,"currentStep":next}))
}
#[tauri::command]
pub fn deepseek_app_cancel_workflow(
    run_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.core.db.lock().map_err(|_| "database unavailable")?;
    init(&db)?;
    db.execute("UPDATE tao_workflow_runs SET status='cancelled',updated_at=?2 WHERE id=?1 AND status NOT IN ('done','cancelled')",params![run_id,crate::deepseek_app::store::now()]).map_err(|e|e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn five_builtin_workflows_are_stable() {
        assert_eq!(definitions().len(), 5);
        assert!(definitions().iter().all(|d| d["builtIn"] == true));
    }
}
