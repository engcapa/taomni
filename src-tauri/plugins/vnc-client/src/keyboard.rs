use std::{
    io::{self, BufRead, BufReader, Write},
    os::windows::process::CommandExt,
    path::PathBuf,
    process::{ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use taomni_vnc_engine::ws::{NativeSpecialKeys, SpecialKeySink};
use taomni_vnc_key_protocol::{HelperLine, parse_helper_line};
use uuid::Uuid;

const HELPER_NAME: &str = "taomni-vnc-key-helper.exe";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone)]
pub(crate) struct Keyboard {
    executable: PathBuf,
    desktop_pid: u32,
    capture: Arc<Mutex<Option<Capture>>>,
}

impl Keyboard {
    pub(crate) fn new(desktop_pid: u32) -> io::Result<Option<Self>> {
        if desktop_pid == 0 {
            return Ok(None);
        }
        let executable = std::env::current_exe()?.with_file_name(HELPER_NAME);
        if !executable.is_file() {
            return Err(io::Error::new(io::ErrorKind::NotFound, HELPER_NAME));
        }
        Ok(Some(Self {
            executable,
            desktop_pid,
            capture: Arc::new(Mutex::new(None)),
        }))
    }

    pub(crate) fn claim(&self) -> Box<dyn NativeSpecialKeys> {
        Box::new(CaptureOwner {
            keyboard: self.clone(),
            id: Uuid::new_v4(),
        })
    }

    fn start(&self, id: Uuid, emit: SpecialKeySink) -> io::Result<Capture> {
        let mut child = Command::new(&self.executable)
            .arg(self.desktop_pid.to_string())
            .env_remove("TAOMNI_PLUGIN_TOKEN")
            .env_remove(taomni_plugin_api::services::HOST_PROFILE_ENV)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("VNC helper stdin unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("VNC helper stdout unavailable"))?;
        let alive = Arc::new(AtomicBool::new(true));
        let active = alive.clone();
        std::thread::Builder::new()
            .name("vnc-module-special-keys".into())
            .spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    if active.load(Ordering::Acquire)
                        && let Some(HelperLine::Key(key)) = parse_helper_line(&line)
                    {
                        emit(key.code, key.down);
                    }
                }
                active.store(false, Ordering::Release);
                let _ = child.wait();
            })?;
        let mut capture = Capture { id, stdin, alive };
        capture.stdin.write_all(b"on\n")?;
        capture.stdin.flush()?;
        Ok(capture)
    }
}

struct Capture {
    id: Uuid,
    stdin: ChildStdin,
    alive: Arc<AtomicBool>,
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
        // The helper also quits on pipe EOF when its owner terminates abruptly.
        let _ = self.stdin.write_all(b"off\n");
        let _ = self.stdin.flush();
    }
}

struct CaptureOwner {
    keyboard: Keyboard,
    id: Uuid,
}

impl CaptureOwner {
    fn release(&self, capture: &mut Option<Capture>) {
        if capture.as_ref().is_some_and(|active| active.id == self.id) {
            capture.take();
        }
    }
}

impl NativeSpecialKeys for CaptureOwner {
    fn set_enabled(&mut self, enabled: bool, emit: &SpecialKeySink) -> Result<(), String> {
        let mut capture = self
            .keyboard
            .capture
            .lock()
            .map_err(|_| "VNC key capture is unavailable".to_string())?;
        if !enabled {
            self.release(&mut capture);
        } else if !capture
            .as_ref()
            .is_some_and(|active| active.id == self.id && active.alive.load(Ordering::Acquire))
        {
            capture.take();
            *capture = Some(
                self.keyboard
                    .start(self.id, emit.clone())
                    .map_err(|error| format!("start signed VNC key helper: {error}"))?,
            );
        }
        Ok(())
    }
}

impl Drop for CaptureOwner {
    fn drop(&mut self) {
        if let Ok(mut capture) = self.keyboard.capture.lock() {
            self.release(&mut capture);
        }
    }
}
