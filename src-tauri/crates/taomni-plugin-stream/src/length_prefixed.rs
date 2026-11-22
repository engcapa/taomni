//! A length-prefixed payload on an already authenticated one-use stream.
//! Read incrementally so an incomplete length never preallocates the promised bytes.
use std::io;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub async fn read(stream: &mut (impl AsyncRead + Unpin)) -> io::Result<Vec<u8>> {
    let length = stream.read_u64().await?;
    let mut data = Vec::new();
    stream.take(length).read_to_end(&mut data).await?;
    if data.len() as u64 != length {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "Incomplete module payload",
        ));
    }
    Ok(data)
}

pub async fn write(stream: &mut (impl AsyncWrite + Unpin), bytes: &[u8]) -> io::Result<()> {
    stream.write_u64(bytes.len() as u64).await?;
    stream.write_all(bytes).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reads_only_one_frame_even_across_multiple_buffer_fills() {
        let (mut sender, mut receiver) = tokio::io::duplex(1024);
        let contents = vec![7; 131073];
        let ((), bytes) = tokio::join!(
            async {
                write(&mut sender, &contents).await.unwrap();
                write(&mut sender, &[]).await.unwrap();
            },
            async {
                let bytes = read(&mut receiver).await.unwrap();
                assert!(read(&mut receiver).await.unwrap().is_empty());
                bytes
            }
        );
        assert_eq!(bytes, contents);
    }

    #[tokio::test]
    async fn rejects_a_truncated_frame_before_allocating_its_declared_size() {
        let mut truncated = io::Cursor::new(u64::MAX.to_be_bytes());
        assert_eq!(
            read(&mut truncated).await.unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }
}
