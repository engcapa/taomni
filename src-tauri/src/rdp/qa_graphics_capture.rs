//! Bounded server-to-client packet evidence for the opt-in QA reference desktop.
//! Enabled only by the QA application setup, never by production sessions.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use serde_json::{Value, json};

const MAX_BYTES: usize = 8_000_000;
static CAPTURE: OnceLock<Mutex<Capture>> = OnceLock::new();

struct Capture {
    file: File,
    bytes: usize,
    next_connection: u64,
}

pub fn enable(directory: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(directory)?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(directory.join("rdp-server-packets.log"))?;
    let _ = CAPTURE.set(Mutex::new(Capture {
        file,
        bytes: 0,
        next_connection: 0,
    }));
    Ok(())
}

impl Capture {
    fn record(&mut self, event: Value) {
        let Ok(mut line) = serde_json::to_vec(&event) else {
            return;
        };
        line.push(b'\n');
        if self.bytes.saturating_add(line.len()) > MAX_BYTES {
            return;
        }
        if self.file.write_all(&line).is_ok() {
            self.bytes += line.len();
        }
    }
}

pub fn begin(
    width: u16,
    height: u16,
    user_channel: u16,
    io_channel: u16,
    share_id: u32,
) -> Option<u64> {
    let mut capture = CAPTURE.get()?.lock().ok()?;
    let connection = capture.next_connection;
    capture.next_connection += 1;
    capture.record(json!({
        "connection": connection, "event": "connected", "width": width, "height": height,
        "user_channel": user_channel, "io_channel": io_channel, "share_id": share_id,
    }));
    Some(connection)
}

pub fn packet(connection: Option<u64>, action: &str, payload: &[u8]) {
    let Some(connection) = connection else {
        return;
    };
    let Some(mut capture) = CAPTURE.get().and_then(|capture| capture.lock().ok()) else {
        return;
    };
    capture.record(json!({
        "connection": connection, "event": "packet", "action": action,
        "payload": hex::encode(payload),
    }));
}

pub fn resized(connection: Option<u64>, width: u16, height: u16) {
    let Some(connection) = connection else {
        return;
    };
    let Some(mut capture) = CAPTURE.get().and_then(|capture| capture.lock().ok()) else {
        return;
    };
    capture.record(json!({
        "connection": connection, "event": "resized", "width": width, "height": height,
    }));
}
