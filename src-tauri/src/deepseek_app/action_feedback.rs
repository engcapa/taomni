//! Feed real, thread-scoped executor outcomes into the next planning turn.
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value, json};

pub fn resolve(db: &Connection, thread: &str, feedback: &[Value]) -> Result<String, String> {
    let mut outcomes = Vec::new();
    for item in feedback.iter().rev().take(20).rev() {
        let id = item["id"]
            .as_str()
            .ok_or("protocol: action feedback ID missing")?;
        let status = item["status"].as_str().unwrap_or("");
        if !matches!(
            status,
            "completed" | "undone" | "invalid" | "cancelled" | "rejected"
        ) {
            continue;
        }
        let result = match status {
            "completed" | "undone" | "invalid" | "cancelled" => {
                let scoped = format!("{thread}:{id}");
                let cached =
                    match db.prepare("SELECT result FROM tao_action_results WHERE action_id=?1") {
                        Ok(mut stmt) => stmt
                            .query_row([&scoped], |r| r.get::<_, String>(0))
                            .optional()
                            .map_err(|e| e.to_string())?,
                        Err(rusqlite::Error::SqliteFailure(_, Some(message)))
                            if message.starts_with("no such table:") =>
                        {
                            None
                        }
                        Err(error) => return Err(error.to_string()),
                    };
                let Some(cached) = cached else {
                    if status == "invalid" {
                        outcomes.push(json!({"id":id,"status":"invalid","result":"The executor could not execute this proposal. Revalidate its target and parameters before proposing a new action."}));
                    }
                    continue;
                };
                let value: Value = serde_json::from_str(&cached)
                    .map_err(|_| "action: invalid persisted result")?;
                // Exact executor data is authoritative. A frontend cannot turn
                // a failed test into a successful one by editing its result.
                json!({"status":value["status"],"exitCode":value["exitCode"],"output":value["output"],"durationMs":value["durationMs"]})
            }
            "rejected" => {
                json!({"output":"The user rejected this proposal. It was not executed; do not retry it implicitly."})
            }
            _ => continue,
        };
        let text = result.to_string();
        let Some((text, _)) = super::local_data::safe_excerpt(&text, 4000) else {
            continue;
        };
        outcomes.push(json!({"id":id,"status":status,"result":text}));
    }
    Ok(if outcomes.is_empty() {
        String::new()
    } else {
        format!(
            "<untrusted_action_results>\n{}\n</untrusted_action_results>",
            json!(outcomes)
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tests_failures_use_executor_result_and_do_not_cross_threads() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE tao_action_results(action_id TEXT PRIMARY KEY,result TEXT);",
        )
        .unwrap();
        db.execute(
            "INSERT INTO tao_action_results VALUES('first:test',?1)",
            [
                json!({"exitCode":1,"output":"test failed password=secret","durationMs":12})
                    .to_string(),
            ],
        )
        .unwrap();
        let feedback = vec![
            json!({"id":"test","status":"completed","result":{"exitCode":0,"output":"fake success"}}),
        ];
        let first = resolve(&db, "first", &feedback).unwrap();
        assert!(first.contains("test failed"));
        let invalid = resolve(
            &db,
            "first",
            &[json!({"id":"test","status":"invalid","result":{"output":"fake output"}})],
        )
        .unwrap();
        assert!(invalid.contains("test failed"));
        assert!(!invalid.contains("fake output"));
        assert!(!first.contains("fake success"));
        assert!(!first.contains("secret"));
        assert!(resolve(&db, "second", &feedback).unwrap().is_empty());
        let rejected =
            resolve(&db, "second", &[json!({"id":"write","status":"rejected"})]).unwrap();
        assert!(rejected.contains("not executed"));
    }
}
