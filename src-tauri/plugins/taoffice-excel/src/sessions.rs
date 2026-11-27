use crate::workbook::{MAX_INPUT_BYTES, Workbook};
use crate::workbook_copy::{self, Edit};
use crate::workbook_package::invalid;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, hash_map::Entry},
    io,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::{Operation, PluginHandler};
use uuid::Uuid;

const MAX_OPEN: usize = 6;
const CHUNK_BYTES: usize = 768 * 1024;
const TRANSFER_IDLE: Duration = Duration::from_secs(30);
const WORKBOOK_IDLE: Duration = Duration::from_secs(20 * 60);

pub struct Workbooks {
    sessions: Arc<Mutex<HashMap<Uuid, Session>>>,
}

struct Session {
    touched: Instant,
    state: State,
    copy: Option<CopyResult>,
}

struct CopyResult {
    id: Uuid,
    bytes: Vec<u8>,
}

enum State {
    Upload { expected: usize, bytes: Vec<u8> },
    Open(Box<Workbook>),
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
struct Append {
    id: Uuid,
    offset: usize,
    data: String,
}

#[derive(Deserialize)]
struct View {
    id: Uuid,
    sheet: String,
    row: u32,
    column: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CopyRequest {
    id: Uuid,
    copy_id: Uuid,
    edits: Vec<Edit>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CopyChunk {
    id: Uuid,
    copy_id: Uuid,
    offset: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CopyIdentity {
    id: Uuid,
    copy_id: Uuid,
}

fn request<T: DeserializeOwned>(params: Option<Value>) -> Result<T, RpcError> {
    serde_json::from_value(params.unwrap_or(Value::Null)).map_err(invalid)
}

fn expired() -> RpcError {
    invalid("This workbook session expired. Reopen the workbook to continue.")
}

fn active(sessions: &mut HashMap<Uuid, Session>, id: Uuid) -> Result<&mut Session, RpcError> {
    let session = sessions.get_mut(&id).ok_or_else(expired)?;
    session.touched = Instant::now();
    Ok(session)
}

fn append(state: &mut State, request: Append) -> Result<(), RpcError> {
    let State::Upload { expected, bytes } = state else {
        return Err(invalid("Workbook is already open"));
    };
    if request.offset != bytes.len() || request.data.len() > CHUNK_BYTES.div_ceil(3) * 4 {
        return Err(invalid("Workbook transfer is out of sequence"));
    }
    let chunk = STANDARD.decode(request.data).map_err(invalid)?;
    if chunk.is_empty() || chunk.len() > CHUNK_BYTES || chunk.len() > *expected - bytes.len() {
        return Err(invalid("Invalid workbook transfer block"));
    }
    bytes.extend(chunk);
    Ok(())
}

impl Workbooks {
    pub fn new() -> io::Result<Self> {
        let sessions = Arc::new(Mutex::new(HashMap::<Uuid, Session>::new()));
        let active = Arc::downgrade(&sessions);
        thread::Builder::new()
            .name("excel-preview-expiry".into())
            .spawn(move || {
                loop {
                    thread::sleep(Duration::from_secs(10));
                    let Some(sessions) = active.upgrade() else {
                        break;
                    };
                    let Ok(mut sessions) = sessions.lock() else {
                        break;
                    };
                    sessions.retain(|_, session| {
                        let idle = match session.state {
                            State::Upload { .. } => TRANSFER_IDLE,
                            State::Open(_) => WORKBOOK_IDLE,
                        };
                        session.touched.elapsed() < idle
                    });
                }
            })?;
        Ok(Self { sessions })
    }
}

impl PluginHandler for Workbooks {
    fn invoke(
        &self,
        operation: &Operation,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, RpcError> {
        operation.check_current()?;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| RpcError::from_code(ErrorCode::InternalError))?;
        match method {
            "workbook/begin" => {
                let Begin { id, size } = request(params)?;
                if size == 0 || size > MAX_INPUT_BYTES {
                    return Err(invalid("XLSX and XLSM preview is limited to 16 MiB"));
                }
                if sessions.len() >= MAX_OPEN {
                    return Err(invalid(
                        "Close another Excel workbook before opening this one",
                    ));
                }
                let Entry::Vacant(slot) = sessions.entry(id) else {
                    return Err(invalid("Workbook session already exists"));
                };
                slot.insert(Session {
                    touched: Instant::now(),
                    state: State::Upload {
                        expected: size,
                        bytes: Vec::new(),
                    },
                    copy: None,
                });
            }
            "workbook/append" => {
                let upload: Append = request(params)?;
                append(&mut active(&mut sessions, upload.id)?.state, upload)?;
            }
            "workbook/open" => {
                let Identity { id } = request(params)?;
                let session = sessions.remove(&id).ok_or_else(expired)?;
                let State::Upload { expected, bytes } = session.state else {
                    sessions.insert(id, session);
                    return Err(invalid("Workbook is already open"));
                };
                if bytes.len() != expected {
                    return Err(invalid("An incomplete workbook was received"));
                }
                let workbook = Workbook::open(bytes)?;
                operation.check_current()?;
                let result = json!({ "sheets": workbook.sheets() });
                sessions.insert(
                    id,
                    Session {
                        touched: Instant::now(),
                        state: State::Open(Box::new(workbook)),
                        copy: None,
                    },
                );
                return Ok(result);
            }
            "workbook/sheet" => {
                let View {
                    id,
                    sheet,
                    row,
                    column,
                } = request(params)?;
                let State::Open(workbook) = &mut active(&mut sessions, id)?.state else {
                    return Err(invalid("Workbook transfer is incomplete"));
                };
                let window = workbook.sheet(&sheet, row, column, || operation.check_current())?;
                return serde_json::to_value(window).map_err(invalid);
            }
            "workbook/copy" => {
                let CopyRequest { id, copy_id, edits } = request(params)?;
                let session = active(&mut sessions, id)?;
                let State::Open(workbook) = &session.state else {
                    return Err(invalid("Workbook transfer is incomplete"));
                };
                session.copy = None;
                let bytes = workbook_copy::create(workbook, edits, || operation.check_current())?;
                let size = bytes.len();
                session.copy = Some(CopyResult { id: copy_id, bytes });
                return Ok(json!({ "size": size }));
            }
            "workbook/copyChunk" => {
                let CopyChunk {
                    id,
                    copy_id,
                    offset,
                } = request(params)?;
                let copy = active(&mut sessions, id)?
                    .copy
                    .as_ref()
                    .filter(|copy| copy.id == copy_id && offset < copy.bytes.len())
                    .ok_or_else(|| invalid("The workbook copy is unavailable"))?;
                let end = copy.bytes.len().min(offset + CHUNK_BYTES);
                return Ok(json!({ "data": STANDARD.encode(&copy.bytes[offset..end]) }));
            }
            "workbook/releaseCopy" => {
                let CopyIdentity { id, copy_id } = request(params)?;
                if let Some(session) = sessions.get_mut(&id)
                    && session.copy.as_ref().is_some_and(|copy| copy.id == copy_id)
                {
                    session.copy = None;
                }
            }
            "workbook/close" => {
                let Identity { id } = request(params)?;
                sessions.remove(&id);
            }
            _ => return Err(RpcError::from_code(ErrorCode::MethodNotFound)),
        }
        Ok(Value::Null)
    }
}
