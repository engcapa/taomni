//! Stream the optional IMAP attachment cache under the module's writer lease.
use std::io;
use taomni_mail_api::attachment_cache::AttachmentCacheRequest;
use taomni_plugin_api::RpcError;
use taomni_plugin_sdk::Operation;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::runtime::Runtime;

use super::incoming::while_current;
use super::store::{Store, open_snapshot_file, unavailable};

pub(super) fn transfer(
    runtime: &Runtime,
    store: &Store,
    operation: &Operation,
    request: AttachmentCacheRequest,
) -> Result<Result<Option<u64>, String>, RpcError> {
    let path = store.attachment_path(&request.key, request.write_size.is_some())?;
    let (mut peer, _) =
        match runtime.block_on(while_current(operation, request.exchange.connect()))? {
            Ok(pair) => pair,
            Err(error) => return Ok(Err(error)),
        };
    let Some((path, work)) = path else {
        return Ok(Ok(None));
    };
    let Some(size) = request.write_size else {
        let source = open_snapshot_file(&path)?;
        let size = source.metadata().map_err(|_| unavailable())?.len();
        let mut source = tokio::fs::File::from_std(source);
        return Ok(runtime
            .block_on(while_current(
                operation,
                tokio::io::copy(&mut source, &mut peer),
            ))?
            .map_err(|error| error.to_string())
            .and_then(|sent| {
                if sent == size {
                    Ok(Some(size))
                } else {
                    Err("Cached Mail attachment changed while reading".into())
                }
            }));
    };
    let staged = tempfile::NamedTempFile::new_in(work).map_err(|_| unavailable())?;
    let mut output = tokio::fs::File::from_std(staged.reopen().map_err(|_| unavailable())?);
    let copied = runtime.block_on(while_current(
        operation,
        copy_exact(&mut peer, &mut output, size),
    ))?;
    if let Err(error) = copied {
        return Ok(Err(error.to_string()));
    }
    drop(output);
    staged.as_file().sync_all().map_err(|_| unavailable())?;
    operation.check_current()?;
    staged.persist(path).map_err(|_| unavailable())?;
    Ok(Ok(Some(size)))
}

async fn copy_exact(
    source: &mut (impl AsyncRead + Unpin),
    output: &mut (impl AsyncWrite + Unpin),
    size: u64,
) -> io::Result<()> {
    let copied = tokio::io::copy(&mut source.take(size), output).await?;
    if copied != size || source.read(&mut [0; 1]).await? != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Incomplete or oversized Mail attachment cache transfer",
        ));
    }
    output.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn only_complete_announced_parts_can_be_published() {
        for (bytes, size, complete) in [
            (&b"abc"[..], 3, true),
            (&b""[..], 0, true),
            (&b"ab"[..], 3, false),
            (&b"abcd"[..], 3, false),
        ] {
            let mut stored = Vec::new();
            assert_eq!(
                copy_exact(&mut &bytes[..], &mut stored, size).await.is_ok(),
                complete
            );
            if complete {
                assert_eq!(stored, bytes);
            }
        }
    }
}
