//! Encode one original from the account's authenticated stream. The desktop
//! keeps its temporary file and SQLite publication lock in the chosen mailbox.
use std::{
    io::{self, BufWriter, Read, Write},
    sync::Arc,
};

use taomni_mail_api::{
    HOST_REQUEST_TIMEOUT,
    archive::{ARCHIVE_FRAME_BYTES, ArchiveEncoding},
};
use taomni_mail_engine::archive::compress_message;
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use tokio::{runtime::Runtime, sync::Semaphore};

use super::incoming::while_current;

pub(super) fn start(
    runtime: &Runtime,
    operation: &Operation,
    request: ArchiveEncoding,
    encoders: &Arc<Semaphore>,
) -> Result<Result<(), String>, RpcError> {
    let permit = runtime
        .block_on(while_current(operation, encoders.clone().acquire_owned()))?
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidState))?;
    let (stream, _) =
        match runtime.block_on(while_current(operation, request.exchange.connect()))? {
            Ok(pair) => pair,
            Err(error) => return Ok(Err(error)),
        };
    operation.check_current()?;
    let socket = || RpcError::new(ErrorCode::InvalidState, "MAIL_ARCHIVE_STREAM_UNAVAILABLE");
    let stream = stream.into_std().map_err(|_| socket())?;
    stream.set_nonblocking(false).map_err(|_| socket())?;
    stream
        .set_read_timeout(Some(HOST_REQUEST_TIMEOUT))
        .map_err(|_| socket())?;
    stream
        .set_write_timeout(Some(HOST_REQUEST_TIMEOUT))
        .map_err(|_| socket())?;
    runtime.spawn_blocking(move || {
        let _permit = permit;
        // No database or profile writer runs past the SDK request. Closing
        // this one-use stream cancels the encoder, including a blocked write.
        // Failure closes the socket without a receipt. The caller then keeps
        // the original and drops its unpublished staging file.
        let _ = encode(&stream, &stream, request.raw_size);
    });
    Ok(Ok(()))
}

fn encode(input: impl Read, output: impl Write, size: u64) -> io::Result<()> {
    let mut output = BufWriter::new(output);
    let mut chunks = ChunkWriter(&mut output);
    let object =
        compress_message(input.take(size), &mut chunks, || Ok(())).map_err(io::Error::other)?;
    if object.raw_size != size {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "Incomplete Mail original",
        ));
    }
    let receipt = serde_json::to_vec(&object)?;
    output.write_all(&0_u32.to_be_bytes())?;
    output.write_all(&(receipt.len() as u32).to_be_bytes())?;
    output.write_all(&receipt)?;
    output.flush()
}

struct ChunkWriter<'a, W>(&'a mut W);

impl<W: Write> Write for ChunkWriter<'_, W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        // A zero-size frame is reserved for the checksum receipt.
        let count = bytes.len().min(ARCHIVE_FRAME_BYTES);
        if count > 0 {
            self.0.write_all(&(count as u32).to_be_bytes())?;
            self.0.write_all(&bytes[..count])?;
        }
        Ok(count)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use taomni_mail_engine::archive::{MessageObject, verify_message};

    #[test]
    fn empty_and_multiframe_originals_roundtrip_and_short_inputs_fail() {
        let mut state = 11_u32;
        let bytes: Vec<_> = (0..4 * ARCHIVE_FRAME_BYTES)
            .map(|_| {
                state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                (state >> 24) as u8
            })
            .collect();
        for raw in [&[][..], bytes.as_slice()] {
            let mut stream = Vec::new();
            encode(raw, &mut stream, raw.len() as u64).unwrap();
            let mut stream = stream.as_slice();
            let mut gzip = Vec::new();
            loop {
                let mut count = [0; 4];
                stream.read_exact(&mut count).unwrap();
                let len = u32::from_be_bytes(count) as usize;
                if len == 0 {
                    break;
                }
                assert!(len <= ARCHIVE_FRAME_BYTES);
                let (chunk, tail) = stream.split_at(len);
                gzip.extend_from_slice(chunk);
                stream = tail;
            }
            let (count, receipt) = stream.split_at(4);
            assert_eq!(
                u32::from_be_bytes(count.try_into().unwrap()) as usize,
                receipt.len()
            );
            let object: MessageObject = serde_json::from_slice(receipt).unwrap();
            let mut decoded = Vec::new();
            verify_message(gzip.as_slice(), &object.hash, object.raw_size, &mut decoded).unwrap();
            assert_eq!(decoded, raw);
        }
        assert_eq!(
            encode(b"x".as_slice(), Vec::new(), 2).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }
}
