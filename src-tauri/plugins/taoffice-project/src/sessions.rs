use crate::import::{MAX_BYTES, mpp_to_mspdi};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::collections::{HashMap, hash_map::Entry};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::{Operation, PluginHandler};
use uuid::Uuid;

const CHUNK_BYTES: usize = 768 * 1024;
const MAX_OPEN: usize = 4;
const TRANSFER_IDLE: Duration = Duration::from_secs(40);

#[derive(Default)]
pub struct Projects {
    sessions: Mutex<HashMap<Uuid, Session>>,
}

struct Session {
    touched: Instant,
    state: State,
}

enum State {
    Upload { size: usize, bytes: Vec<u8> },
    Converting(Arc<()>),
    Ready(Vec<u8>),
}

#[derive(Deserialize)]
struct Identity {
    id: Uuid,
}

#[derive(Deserialize)]
struct Begin {
    id: Uuid,
    size: usize,
}

#[derive(Deserialize)]
struct Offset {
    id: Uuid,
    offset: usize,
}

#[derive(Deserialize)]
struct Append {
    #[serde(flatten)]
    position: Offset,
    data: String,
}

fn invalid(message: impl ToString) -> RpcError {
    RpcError::new(ErrorCode::InvalidParams, message.to_string())
}

fn request<T: DeserializeOwned>(params: Option<Value>) -> Result<T, RpcError> {
    serde_json::from_value(params.unwrap_or(Value::Null)).map_err(invalid)
}

fn expired() -> RpcError {
    invalid("This Project import expired. Reopen the file to try again.")
}

impl Projects {
    fn sessions(&self) -> Result<MutexGuard<'_, HashMap<Uuid, Session>>, RpcError> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| RpcError::from_code(ErrorCode::InternalError))?;
        sessions.retain(|_, session| session.touched.elapsed() < TRANSFER_IDLE);
        Ok(sessions)
    }

    fn convert(&self, operation: &Operation, id: Uuid) -> Result<Value, RpcError> {
        let generation = Arc::new(());
        let bytes = {
            let mut sessions = self.sessions()?;
            let session = sessions.get_mut(&id).ok_or_else(expired)?;
            let State::Upload { size, bytes } = &mut session.state else {
                return Err(invalid("Project import is already running or complete"));
            };
            if bytes.len() != *size {
                return Err(invalid("An incomplete Project file was received"));
            }
            let bytes = std::mem::take(bytes);
            session.state = State::Converting(generation.clone());
            session.touched = Instant::now();
            bytes
        };
        let converted = mpp_to_mspdi(&bytes, || {
            operation.check_current().map_err(|error| error.message)
        });
        let mut sessions = self.sessions()?;
        let same_import = |session: &Session| {
            matches!(&session.state,
            State::Converting(current) if Arc::ptr_eq(current, &generation))
        };
        let result = operation
            .check_current()
            .and_then(|()| converted.map_err(invalid));
        match result {
            Ok(xml) => {
                let session = sessions
                    .get_mut(&id)
                    .filter(|session| same_import(session))
                    .ok_or_else(expired)?;
                let size = xml.len();
                session.state = State::Ready(xml);
                session.touched = Instant::now();
                Ok(json!({ "size": size }))
            }
            Err(error) => {
                if sessions.get(&id).is_some_and(same_import) {
                    sessions.remove(&id);
                }
                Err(error)
            }
        }
    }
}

impl PluginHandler for Projects {
    fn invoke(
        &self,
        operation: &Operation,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, RpcError> {
        operation.check_current()?;
        if method == "project/convert" {
            return self.convert(operation, request::<Identity>(params)?.id);
        }
        let mut sessions = self.sessions()?;
        match method {
            "project/begin" => {
                let Begin { id, size } = request(params)?;
                if size == 0 || size > MAX_BYTES {
                    return Err(invalid("Project previews are limited to 8 MiB"));
                }
                if sessions.len() >= MAX_OPEN {
                    return Err(invalid(
                        "Other Project imports are already in progress. Try again shortly.",
                    ));
                }
                let Entry::Vacant(slot) = sessions.entry(id) else {
                    return Err(invalid("Project import already exists"));
                };
                slot.insert(Session {
                    touched: Instant::now(),
                    state: State::Upload {
                        size,
                        bytes: Vec::new(),
                    },
                });
            }
            "project/append" => {
                let Append {
                    position: Offset { id, offset },
                    data,
                } = request(params)?;
                let session = sessions.get_mut(&id).ok_or_else(expired)?;
                let State::Upload { size, bytes } = &mut session.state else {
                    return Err(invalid("Project import is already running or complete"));
                };
                if offset != bytes.len() || data.len() > CHUNK_BYTES.div_ceil(3) * 4 {
                    return Err(invalid("Project transfer is out of sequence"));
                }
                let block = STANDARD.decode(data).map_err(invalid)?;
                if block.is_empty() || block.len() > CHUNK_BYTES || block.len() > *size - offset {
                    return Err(invalid("Invalid Project transfer block"));
                }
                bytes.extend(block);
                session.touched = Instant::now();
            }
            "project/read" => {
                let Offset { id, offset } = request(params)?;
                let session = sessions.get_mut(&id).ok_or_else(expired)?;
                let State::Ready(xml) = &session.state else {
                    return Err(invalid("Project import is incomplete"));
                };
                if offset >= xml.len() {
                    return Err(invalid("Invalid Project output offset"));
                }
                session.touched = Instant::now();
                let end = (offset + CHUNK_BYTES).min(xml.len());
                return Ok(json!({ "data": STANDARD.encode(&xml[offset..end]) }));
            }
            "project/close" => {
                let Identity { id } = request(params)?;
                sessions.remove(&id);
            }
            _ => return Err(RpcError::from_code(ErrorCode::MethodNotFound)),
        }
        Ok(Value::Null)
    }
}
