use super::parameters::SessionAuthParams;
use super::parameters::SessionOpenParams;
use crate::session::models::AuthMethod;
use crate::session::models::SessionConfig;
use crate::session::models::SessionType;
use serde_json::Map;
use serde_json::Value;

pub(super) fn parse_session_type(s: &str) -> Result<SessionType, String> {
    let canonical = [
        "SSH",
        "Telnet",
        "Rlogin",
        "RDP",
        "VNC",
        "FTP",
        "SFTP",
        "Serial",
        "LocalShell",
        "File",
        "Browser",
        "Mosh",
        "MySQL",
        "PostgreSQL",
        "PanWeiDB",
        "Oracle",
        "SQLServer",
        "StarRocks",
        "ClickHouse",
        "Presto",
        "Redis",
        "HBaseShell",
        "Proxy",
        "S3",
        "AzureBlob",
    ];
    if canonical.iter().any(|v| v.eq_ignore_ascii_case(s)) {
        Ok(SessionType::from_str(s))
    } else {
        Err(format!("unknown session_type '{s}'"))
    }
}

pub(super) fn validate_secret_free_options(value: &Value) -> Result<(), String> {
    fn walk(value: &Value, key_hint: Option<&str>) -> Result<(), String> {
        match value {
            Value::Object(map) => {
                for (k, v) in map {
                    walk(v, Some(k))?;
                }
            }
            Value::Array(items) => {
                for item in items {
                    walk(item, key_hint)?;
                }
            }
            Value::String(s) => {
                let key = key_hint.unwrap_or("");
                if is_secretish_key(key) && !s.is_empty() && !s.starts_with("vault:") {
                    return Err(format!(
                        "plaintext secret rejected in options key '{}'; use a vault:<id> reference",
                        key_hint.unwrap_or("<unknown>")
                    ));
                }
            }
            _ => {}
        }
        Ok(())
    }
    walk(value, None)
}

pub(super) fn is_secretish_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key.contains("password") || key.contains("passphrase") || key == "pass"
}

pub(super) fn redact_secret_options(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = Map::new();
            for (k, v) in map {
                if is_secretish_key(k) {
                    out.insert(k.clone(), Value::String("<redacted>".into()));
                } else {
                    out.insert(k.clone(), redact_secret_options(v));
                }
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(redact_secret_options).collect()),
        _ => value.clone(),
    }
}

pub(super) fn parse_options(value: Option<Value>) -> Result<Map<String, Value>, String> {
    let Some(value) = value else {
        return Ok(Map::new());
    };
    validate_secret_free_options(&value)?;
    match value {
        Value::Object(map) => Ok(map),
        _ => Err("options must be a JSON object".into()),
    }
}

pub(super) fn merge_options_json(existing: &str, patch: Option<Value>) -> Result<String, String> {
    let mut base =
        match serde_json::from_str::<Value>(existing).unwrap_or(Value::Object(Map::new())) {
            Value::Object(map) => map,
            _ => Map::new(),
        };
    for (k, v) in parse_options(patch)? {
        base.insert(k, v);
    }
    Ok(Value::Object(base).to_string())
}

pub(super) fn apply_auth(
    auth: Option<&SessionAuthParams>,
    options: &mut Map<String, Value>,
    current: Option<AuthMethod>,
) -> Result<AuthMethod, String> {
    let Some(auth) = auth else {
        return Ok(current.unwrap_or(AuthMethod::None));
    };
    match auth.method.trim().to_ascii_lowercase().as_str() {
        "none" => {
            options.remove("passwordRef");
            Ok(AuthMethod::None)
        }
        "agent" => {
            options.remove("passwordRef");
            Ok(AuthMethod::Agent)
        }
        "private_key" | "privatekey" => {
            options.remove("passwordRef");
            let path = auth
                .private_key_path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("private_key auth requires private_key_path")?;
            Ok(AuthMethod::PrivateKey {
                key_path: path.to_string(),
            })
        }
        "password_ref" | "passwordref" => {
            let reference = auth
                .password_ref
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("password_ref auth requires password_ref")?;
            if !reference.starts_with("vault:") {
                return Err("password_ref must be a vault:<id> reference".into());
            }
            options.insert("passwordRef".into(), Value::String(reference.to_string()));
            Ok(AuthMethod::Password)
        }
        "password" => Err("plaintext Password auth is not accepted; use password_ref".into()),
        other => Err(format!("unknown auth method '{other}'")),
    }
}

pub(super) fn session_to_safe_value(session: &SessionConfig) -> Value {
    let raw_options = serde_json::from_str::<Value>(&session.options_json).unwrap_or(Value::Null);
    serde_json::json!({
        "id": session.id,
        "name": session.name,
        "session_type": session.session_type.as_str(),
        "group_path": session.group_path,
        "host": session.host,
        "port": session.port,
        "username": session.username,
        "auth_method": session.auth_method.as_str(),
        "options": redact_secret_options(&raw_options),
        "created_at": session.created_at,
        "updated_at": session.updated_at,
        "last_connected_at": session.last_connected_at,
        "sort_order": session.sort_order,
    })
}

pub(super) fn resolve_session_query(
    sessions: &[SessionConfig],
    p: &SessionOpenParams,
) -> Result<String, String> {
    if let Some(id) = p
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Ok(id.to_string());
    }
    let q = p
        .query
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("session_open requires session_id or query")?
        .to_lowercase();
    let matches: Vec<&SessionConfig> = sessions
        .iter()
        .filter(|s| {
            s.id.to_lowercase() == q
                || s.name.to_lowercase().contains(&q)
                || s.host.to_lowercase().contains(&q)
        })
        .collect();
    match matches.as_slice() {
        [one] => Ok(one.id.clone()),
        [] => Err(format!("no session matched '{q}'")),
        many => Err(format!(
            "query '{q}' matched multiple sessions: {}",
            many.iter()
                .map(|s| format!("{} ({})", s.name, s.id))
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}
