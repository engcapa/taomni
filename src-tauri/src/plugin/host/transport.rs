//! Bounded stdio workers. Neither a blocked pipe write nor a silent host may
//! prevent the caller from observing cancellation or enforcing a deadline.

use std::io::{self, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender, TrySendError};
use std::thread;
use std::time::{Duration, Instant};

use super::super::containment::ProcessContainment;
use super::{HostCancellation, HostProcessError, JsonLineCodec, RequestId, RpcMessage};

type ReadResult = Result<RpcMessage, HostProcessError>;
type WriteTask = (Vec<u8>, Option<SyncSender<io::Result<()>>>);

#[derive(Debug)]
pub(super) struct Transport {
    child: Child,
    spawn_owner: Option<Sender<()>>,
    containment: ProcessContainment,
    writer: SyncSender<WriteTask>,
    pub(super) reader: Receiver<ReadResult>,
}

impl Transport {
    pub(super) fn spawn(mut command: Command) -> Result<Self, HostProcessError> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut containment =
            ProcessContainment::prepare(&mut command).map_err(HostProcessError::Spawn)?;
        let (spawned, child_receiver) = mpsc::sync_channel(1);
        let (spawn_owner, owner_lifetime) = mpsc::channel::<()>();
        // Linux PDEATHSIG follows the particular thread that called fork,
        // even if the application is still running. Tauri blocking-pool
        // threads may expire; keep a dedicated spawn owner alive until cleanup.
        thread::Builder::new()
            .name("plugin-spawn-owner".into())
            .spawn(move || match command.spawn() {
                Ok(child) => {
                    if let Err(mpsc::SendError(Ok(mut child))) = spawned.send(Ok(child)) {
                        let _ = child.kill();
                        let _ = child.wait();
                        return;
                    }
                    let _ = owner_lifetime.recv();
                }
                Err(error) => {
                    let _ = spawned.send(Err(error));
                }
            })
            .map_err(HostProcessError::Spawn)?;
        let mut child = child_receiver
            .recv()
            .map_err(|_| HostProcessError::Crashed)?
            .map_err(HostProcessError::Spawn)?;
        if let Err(error) = containment.attach(&child) {
            // In particular a suspended Windows child must not survive a job
            // assignment failure; fail closed before any plugin code runs.
            let _ = child.kill();
            let _ = child.wait();
            return Err(HostProcessError::Spawn(error));
        }
        let stdin = child.stdin.take().expect("piped plugin stdin");
        let stdout = child.stdout.take().expect("piped plugin stdout");
        let (sender, reader) = mpsc::sync_channel(128);
        thread::spawn(move || read_frames(stdout, sender));
        let (writer, writes) = mpsc::sync_channel::<WriteTask>(8);
        thread::spawn(move || {
            let mut stdin = stdin;
            while let Ok((bytes, receipt)) = writes.recv() {
                let result = stdin.write_all(&bytes).and_then(|()| stdin.flush());
                let failed = result.is_err();
                if let Some(receipt) = receipt {
                    let _ = receipt.send(result);
                }
                if failed {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            spawn_owner: Some(spawn_owner),
            containment,
            writer,
            reader,
        })
    }

    pub(super) fn exited(&mut self) -> bool {
        !matches!(self.child.try_wait(), Ok(None))
    }

    pub(super) fn notify(&self, message: &RpcMessage) -> Result<(), HostProcessError> {
        self.queue(message, None)
    }

    pub(super) fn write(
        &self,
        message: &RpcMessage,
        deadline: Instant,
        cancellation: Option<(&HostCancellation, &RequestId)>,
    ) -> Result<(), HostProcessError> {
        let (sender, receipt) = mpsc::sync_channel(1);
        self.queue(message, Some(sender))?;
        loop {
            if cancellation.is_some_and(|(handle, id)| handle.is_cancelled(id)) {
                return Err(HostProcessError::Cancelled);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(HostProcessError::Timeout);
            }
            match receipt.recv_timeout(remaining.min(Duration::from_millis(20))) {
                Ok(result) => return result.map_err(HostProcessError::Io),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err(HostProcessError::Crashed),
            }
        }
    }

    fn queue(
        &self,
        message: &RpcMessage,
        receipt: Option<SyncSender<io::Result<()>>>,
    ) -> Result<(), HostProcessError> {
        let bytes = JsonLineCodec::encode(message)?;
        if bytes.len() > super::super::DEFAULT_MAX_FRAME_BYTES + 1 {
            return Err(HostProcessError::Frame(
                super::super::FrameError::TooLarge {
                    max: super::super::DEFAULT_MAX_FRAME_BYTES,
                },
            ));
        }
        self.writer
            .try_send((bytes, receipt))
            .map_err(|error| match error {
                TrySendError::Disconnected(_) => HostProcessError::Crashed,
                TrySendError::Full(_) => HostProcessError::Io(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "plugin control-channel write queue is full",
                )),
            })
    }
}

impl Drop for Transport {
    fn drop(&mut self) {
        self.containment.terminate();
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.spawn_owner.take();
    }
}

fn read_frames(mut stdout: impl Read, sender: SyncSender<ReadResult>) {
    let mut codec = JsonLineCodec::default();
    let mut bytes = [0u8; 8 * 1024];
    loop {
        match stdout.read(&mut bytes) {
            Ok(0) => break,
            Ok(count) => match codec.push(&bytes[..count]) {
                Ok(messages) => {
                    for message in messages {
                        if sender.send(Ok(message)).is_err() {
                            return;
                        }
                    }
                }
                Err(error) => {
                    let _ = sender.send(Err(HostProcessError::Frame(error)));
                    return;
                }
            },
            Err(error) => {
                let _ = sender.send(Err(HostProcessError::Io(error)));
                return;
            }
        }
    }
    let _ = sender.send(Err(HostProcessError::Crashed));
}
