use std::io::{self, Cursor, Seek, SeekFrom, Write};
use std::sync::{Arc, Mutex};

const MAX_OUTPUT: usize = 32 * 1024 * 1024;

#[derive(Clone, Default)]
pub(super) struct OutputBuffer(Arc<Mutex<Cursor<Vec<u8>>>>);

impl OutputBuffer {
    pub(super) fn finish(self) -> Result<Vec<u8>, String> {
        Arc::into_inner(self.0)
            .and_then(|buffer| buffer.into_inner().ok())
            .map(Cursor::into_inner)
            .filter(|bytes| !bytes.is_empty())
            .ok_or_else(|| "The conversion produced no media.".into())
    }
}

impl Write for OutputBuffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let mut buffer = self
            .0
            .lock()
            .map_err(|_| io::Error::other("The output buffer is unavailable."))?;
        if buffer.position().saturating_add(bytes.len() as u64) > MAX_OUTPUT as u64 {
            return Err(io::Error::new(
                io::ErrorKind::StorageFull,
                "The converted media exceeds 32 MiB.",
            ));
        }
        buffer.write(bytes)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Seek for OutputBuffer {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        let mut buffer = self
            .0
            .lock()
            .map_err(|_| io::Error::other("The output buffer is unavailable."))?;
        let start = buffer.position();
        let end = buffer.seek(position)?;
        if end > MAX_OUTPUT as u64 {
            buffer.set_position(start);
            return Err(io::Error::new(
                io::ErrorKind::StorageFull,
                "The converted media exceeds 32 MiB.",
            ));
        }
        Ok(end)
    }
}
