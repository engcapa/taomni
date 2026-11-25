use super::model::RfbConnection;
use std::io::Read;
use std::io::Write;

impl RfbConnection {
    // --- I/O helpers ---

    pub(super) fn read_exact(&mut self, buf: &mut [u8]) -> std::io::Result<()> {
        match self.secure_io.as_mut() {
            Some(io) => io.read_exact(&mut self.stream, buf),
            None => self.read_buffer.read_exact(&mut self.stream, buf),
        }
    }

    pub(super) fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()> {
        match self.secure_io.as_mut() {
            Some(io) => io.write_all(&mut self.stream, buf),
            None => self.stream.write_all(buf),
        }
    }

    pub(super) fn flush(&mut self) -> std::io::Result<()> {
        self.stream.flush()
    }

    pub(super) fn read_u8(&mut self) -> Result<u8, String> {
        let mut buf = [0u8; 1];
        self.read_exact(&mut buf)
            .map_err(|e| format!("read u8: {}", e))?;
        Ok(buf[0])
    }

    pub(super) fn read_u16(&mut self) -> Result<u16, String> {
        let mut buf = [0u8; 2];
        self.read_exact(&mut buf)
            .map_err(|e| format!("read u16: {}", e))?;
        Ok(u16::from_be_bytes(buf))
    }

    pub(super) fn read_u32(&mut self) -> Result<u32, String> {
        let mut buf = [0u8; 4];
        self.read_exact(&mut buf)
            .map_err(|e| format!("read u32: {}", e))?;
        Ok(u32::from_be_bytes(buf))
    }

    pub(super) fn read_i32(&mut self) -> Result<i32, String> {
        let mut buf = [0u8; 4];
        self.read_exact(&mut buf)
            .map_err(|e| format!("read i32: {}", e))?;
        Ok(i32::from_be_bytes(buf))
    }
}
