//! Full IMAP sync streams one original at a time and waits for its save result.

use std::io::{self, Read, Write};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite};

use super::{read_body_frame, read_payload, write_frame};

pub const MAX_ORIGINAL_BYTES: u32 = 10 * 1024 * 1024;
const MAX_ACK_BYTES: usize = 64 * 1024;

pub enum SyncFrame {
    Original { uid: u32, bytes: Vec<u8> },
    Reply(Vec<u8>),
}

pub async fn read_sync_frame(stream: &mut (impl AsyncRead + Unpin)) -> io::Result<SyncFrame> {
    // IMAP UID zero is reserved for the final outcome.
    let uid = stream.read_u32().await?;
    if uid == 0 {
        return read_body_frame(stream).await.map(SyncFrame::Reply);
    }
    let size = stream.read_u32().await?;
    if size > MAX_ORIGINAL_BYTES {
        return Err(invalid("Mail sync original exceeds the fetch limit"));
    }
    let bytes = read_payload(stream, size as usize).await?;
    Ok(SyncFrame::Original { uid, bytes })
}

pub async fn write_save_result(
    stream: &mut (impl AsyncWrite + Unpin),
    result: Result<(), String>,
) -> io::Result<()> {
    let reply = serde_json::to_vec(&result).map_err(io::Error::other)?;
    if reply.len() > MAX_ACK_BYTES {
        return Err(invalid("Mail save result exceeds its limit"));
    }
    write_frame(stream, &reply).await
}

pub fn save_original(
    stream: &mut (impl Read + Write),
    uid: u32,
    bytes: &[u8],
) -> io::Result<Result<(), String>> {
    if uid == 0 || bytes.len() > MAX_ORIGINAL_BYTES as usize {
        return Err(invalid("Invalid Mail sync original"));
    }
    stream.write_all(&uid.to_be_bytes())?;
    stream.write_all(&(bytes.len() as u32).to_be_bytes())?;
    stream.write_all(bytes)?;
    stream.flush()?;
    let mut size = [0; 4];
    stream.read_exact(&mut size)?;
    let size = u32::from_be_bytes(size) as usize;
    if size > MAX_ACK_BYTES {
        return Err(invalid("Mail save result exceeds its limit"));
    }
    let mut reply = vec![0; size];
    stream.read_exact(&mut reply)?;
    serde_json::from_slice(&reply).map_err(io::Error::other)
}

pub fn write_sync_reply(stream: &mut impl Write, frame: &[u8]) -> io::Result<()> {
    stream.write_all(&0_u32.to_be_bytes())?;
    stream.write_all(&(frame.len() as u64).to_be_bytes())?;
    stream.write_all(frame)
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use tokio::io::AsyncWriteExt;

    #[tokio::test]
    async fn transfers_one_original_and_returns_the_desktop_save_failure() {
        let original = b"Subject: fixture\r\n\r\nOriginal bytes";
        let (mut receiver, mut writer) = tokio::io::duplex(256);
        write_save_result(&mut writer, Err("destination refused the save".into()))
            .await
            .unwrap();
        writer.shutdown().await.unwrap();
        let mut payload = vec![0; 8 + original.len()];
        receiver.read_to_end(&mut payload).await.unwrap();
        let mut transport = Cursor::new(payload);
        assert_eq!(
            save_original(&mut transport, 17, original).unwrap(),
            Err("destination refused the save".into())
        );
        let mut bytes = &transport.get_ref()[..8 + original.len()];
        let SyncFrame::Original { uid, bytes } = read_sync_frame(&mut bytes).await.unwrap() else {
            panic!("expected an original frame");
        };
        assert_eq!(uid, 17);
        assert_eq!(bytes, original);
    }

    #[tokio::test]
    async fn distinguishes_final_results_from_oversized_originals() {
        let mut reply = Vec::new();
        write_sync_reply(&mut reply, b"finished").unwrap();
        let SyncFrame::Reply(bytes) = read_sync_frame(&mut reply.as_slice()).await.unwrap() else {
            panic!("expected the final reply frame");
        };
        assert_eq!(bytes, b"finished");
        let mut size = 17_u32.to_be_bytes().to_vec();
        size.extend((MAX_ORIGINAL_BYTES + 1).to_be_bytes());
        assert_eq!(
            read_sync_frame(&mut size.as_slice())
                .await
                .err()
                .unwrap()
                .kind(),
            io::ErrorKind::InvalidData
        );
    }
}
