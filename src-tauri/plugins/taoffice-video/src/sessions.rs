use crate::transcode::{ConversionOptions, Converted, MAX_INPUT_BYTES, convert};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, hash_map::Entry},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, AtomicU16, AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::{Operation, PluginHandler};
use uuid::Uuid;

const CHUNK_SIZE: usize = 768 * 1024;
const MAX_SESSIONS: usize = 4;
const MAX_RUNNING: usize = 2;
const IDLE: Duration = Duration::from_secs(120);
const MAX_CONVERSION_TIME: Duration = Duration::from_secs(600);
const UNKNOWN_PROGRESS: u16 = u16::MAX;

#[derive(Default)]
pub(crate) struct MediaJobs {
    jobs: Mutex<HashMap<Uuid, Job>>,
    workers: Arc<AtomicUsize>,
}

struct Job {
    touched: Instant,
    state: State,
}

enum State {
    Upload { size: usize, bytes: Vec<u8> },
    Converting(Arc<Running>),
}

struct Running {
    cancelled: AtomicBool,
    progress: AtomicU16,
    result: Mutex<Option<Result<Converted, String>>>,
}

impl Drop for Job {
    fn drop(&mut self) {
        if let State::Converting(work) = &self.state {
            work.cancelled.store(true, Ordering::Relaxed);
        }
    }
}

struct WorkerSlot(Arc<AtomicUsize>);

impl Drop for WorkerSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

#[derive(Deserialize)]
struct Ident {
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

#[derive(Deserialize)]
struct Convert {
    id: Uuid,
    options: ConversionOptions,
}

fn invalid(message: impl ToString) -> RpcError {
    RpcError::new(ErrorCode::InvalidParams, message.to_string())
}

fn internal() -> RpcError {
    RpcError::from_code(ErrorCode::InternalError)
}

fn request<T: DeserializeOwned>(params: Option<Value>) -> Result<T, RpcError> {
    serde_json::from_value(params.unwrap_or(Value::Null)).map_err(invalid)
}

fn expired() -> RpcError {
    invalid("This media conversion expired. Try again.")
}

fn job(jobs: &mut HashMap<Uuid, Job>, id: Uuid) -> Result<&mut Job, RpcError> {
    let job = jobs.get_mut(&id).ok_or_else(expired)?;
    job.touched = Instant::now();
    Ok(job)
}

impl Running {
    fn status(&self) -> Result<Value, RpcError> {
        let result = self.result.lock().map_err(|_| internal())?;
        match result.as_ref() {
            Some(Ok(output)) => {
                Ok(json!({ "state": "ready", "size": output.bytes.len(), "mime": output.mime }))
            }
            Some(Err(error)) => Ok(json!({ "state": "error", "error": error })),
            None => {
                let progress = self.progress.load(Ordering::Relaxed);
                let progress =
                    (progress != UNKNOWN_PROGRESS).then_some(f64::from(progress) / 1000.0);
                Ok(json!({ "state": "converting", "progress": progress }))
            }
        }
    }

    fn read(&self, offset: usize) -> Result<Value, RpcError> {
        let result = self.result.lock().map_err(|_| internal())?;
        let Some(Ok(output)) = result.as_ref() else {
            return Err(invalid("The converted media is not ready."));
        };
        if offset >= output.bytes.len() {
            return Err(invalid("Invalid media transfer offset."));
        }
        let end = (offset + CHUNK_SIZE).min(output.bytes.len());
        Ok(json!({ "data": STANDARD.encode(&output.bytes[offset..end]) }))
    }
}

impl MediaJobs {
    fn sessions(&self) -> Result<MutexGuard<'_, HashMap<Uuid, Job>>, RpcError> {
        let mut jobs = self.jobs.lock().map_err(|_| internal())?;
        jobs.retain(|_, job| job.touched.elapsed() < IDLE);
        Ok(jobs)
    }

    fn start(&self, job: &mut Job, options: ConversionOptions) -> Result<(), RpcError> {
        let State::Upload { size, bytes } = &mut job.state else {
            return Err(invalid("This media conversion already started."));
        };
        if bytes.len() != *size {
            return Err(invalid("An incomplete media file was received."));
        }
        if options.end_ms.is_some_and(|end| end <= options.start_ms)
            || options
                .width
                .is_some_and(|width| !(16..=8192).contains(&width))
        {
            return Err(invalid(
                "The selected trim range or export width is invalid.",
            ));
        }
        self.workers
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |count| {
                (count < MAX_RUNNING).then_some(count + 1)
            })
            .map_err(|_| invalid("Other media conversions are running. Try again shortly."))?;
        let slot = WorkerSlot(self.workers.clone());
        let work = Arc::new(Running {
            cancelled: AtomicBool::new(false),
            progress: AtomicU16::new(UNKNOWN_PROGRESS),
            result: Mutex::new(None),
        });
        let owned = Arc::clone(&work);
        let bytes = std::mem::take(bytes);
        job.state = State::Converting(work);
        thread::Builder::new()
            .name("taoffice-media-convert".into())
            .spawn(move || {
                let _slot = slot;
                let cancel = Arc::clone(&owned);
                let deadline = Instant::now() + MAX_CONVERSION_TIME;
                let current = Arc::new(move || {
                    cancel.cancelled.load(Ordering::Relaxed) || Instant::now() >= deadline
                });
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    convert(bytes, options, current, |progress| {
                        if let Some(progress) = progress {
                            let progress = (progress * 1000.0).round() as u16;
                            let _ = owned.progress.fetch_update(
                                Ordering::Relaxed,
                                Ordering::Relaxed,
                                |last| {
                                    if last == UNKNOWN_PROGRESS || progress > last {
                                        Some(progress)
                                    } else {
                                        None
                                    }
                                },
                            );
                        }
                    })
                }))
                .unwrap_or_else(|_| Err("The media converter could not process this file.".into()));
                let result = if Instant::now() >= deadline {
                    Err("The conversion took too long. Choose a shorter clip.".into())
                } else {
                    result
                };
                if let Ok(mut dest) = owned.result.lock() {
                    *dest = Some(result);
                }
            })
            .map_err(|_| internal())?;
        Ok(())
    }
}

impl PluginHandler for MediaJobs {
    fn invoke(
        &self,
        operation: &Operation,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, RpcError> {
        operation.check_current()?;
        let mut jobs = self.sessions()?;
        match method {
            "media/begin" => {
                let Begin { id, size } = request(params)?;
                if size == 0 || size > MAX_INPUT_BYTES {
                    return Err(invalid("Media conversion is limited to 32 MiB input."));
                }
                if jobs.len() >= MAX_SESSIONS {
                    return Err(invalid(
                        "Other media conversions are running. Try again shortly.",
                    ));
                }
                let Entry::Vacant(entry) = jobs.entry(id) else {
                    return Err(invalid("This media conversion already exists."));
                };
                entry.insert(Job {
                    touched: Instant::now(),
                    state: State::Upload {
                        size,
                        bytes: Vec::new(),
                    },
                });
            }
            "media/append" => {
                let Append {
                    position: Offset { id, offset },
                    data,
                } = request(params)?;
                let State::Upload { size, bytes } = &mut job(&mut jobs, id)?.state else {
                    return Err(invalid("This media conversion already started."));
                };
                if offset != bytes.len() || data.len() > CHUNK_SIZE.div_ceil(3) * 4 {
                    return Err(invalid("The media transfer is out of sequence."));
                }
                let block = STANDARD.decode(data).map_err(invalid)?;
                if block.is_empty() || block.len() > CHUNK_SIZE || block.len() > *size - offset {
                    return Err(invalid("Invalid media transfer block."));
                }
                bytes.extend_from_slice(&block);
            }
            "media/convert" => {
                let Convert { id, options } = request(params)?;
                self.start(job(&mut jobs, id)?, options)?;
            }
            "media/status" => {
                let Ident { id } = request(params)?;
                let State::Converting(work) = &job(&mut jobs, id)?.state else {
                    return Err(invalid("The media conversion has not started."));
                };
                return work.status();
            }
            "media/read" => {
                let Offset { id, offset } = request(params)?;
                let State::Converting(work) = &job(&mut jobs, id)?.state else {
                    return Err(invalid("The media conversion has not started."));
                };
                return work.read(offset);
            }
            "media/close" => {
                let Ident { id } = request(params)?;
                jobs.remove(&id);
            }
            _ => return Err(RpcError::from_code(ErrorCode::MethodNotFound)),
        }
        Ok(Value::Null)
    }
}
