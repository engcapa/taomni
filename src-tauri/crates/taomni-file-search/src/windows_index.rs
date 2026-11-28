//! Query the Windows Search index in-process. OnlyUseIndexer avoids a recursive
//! filesystem scan when a drive is only partly indexed.
use crate::providers::{Indexed, MAX_CANDIDATES};
use crate::{Provider, check_cancelled};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::Duration;
use tokio::time::Instant;
use windows::Storage::Search::{FolderDepth, IndexedState, IndexerOption, QueryOptions};
use windows::Storage::StorageFolder;
use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
use windows::core::{HSTRING, PCWSTR, RuntimeType};
use windows_future::IAsyncOperation;

pub(super) fn fixed_drive_mask() -> u32 {
    // SAFETY: GetLogicalDrives takes no arguments. Each GetDriveTypeW call
    // receives a live, NUL-terminated UTF-16 drive root.
    let logical = unsafe { GetLogicalDrives() };
    (0..26)
        .filter(|&i| logical & (1 << i) != 0)
        .fold(0, |mask, i| {
            let root = [u16::from(b'A' + i), 58, 92, 0];
            match unsafe { GetDriveTypeW(PCWSTR(root.as_ptr())) } {
                3 | 6 => mask | (1 << i),
                _ => mask,
            }
        })
}

struct Pending<T: RuntimeType + 'static>(Option<IAsyncOperation<T>>);
impl<T: RuntimeType> Drop for Pending<T> {
    fn drop(&mut self) {
        if let Some(op) = &self.0 {
            let _ = op.Cancel();
        }
    }
}

async fn wait<T: RuntimeType>(
    operation: IAsyncOperation<T>,
    deadline: Instant,
    cancelled: &AtomicBool,
) -> Option<T> {
    let mut pending = Pending(Some(operation.clone()));
    let stop = async {
        while check_cancelled(cancelled).is_ok() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(12)).await;
        }
    };
    tokio::select! {
        result = operation => {
            pending.0 = None;
            result.ok()
        }
        _ = stop => None,
    }
}

async fn query_drive(
    drive: u8,
    options: &QueryOptions,
    remaining: usize,
    deadline: Instant,
    cancelled: &AtomicBool,
) -> Option<(Vec<PathBuf>, bool)> {
    let root = HSTRING::from(format!("{}:\\", char::from(drive)));
    let open = StorageFolder::GetFolderFromPathAsync(&root).ok()?;
    // StorageFolder, StorageItemQueryResult and IVectorView are apartment
    // objects. Retain only agile asynchronous operations across await points
    // so Tauri can move its command future between runtime threads.
    let (fetch, mut index_state) = {
        let folder = wait(open, deadline, cancelled).await?;
        let query = folder.CreateItemQueryWithOptions(options).ok()?;
        (
            query.GetItemsAsync(0, remaining as u32).ok()?,
            Pending(folder.GetIndexedStateAsync().ok()),
        )
    };
    let (count, paths) = {
        let items = wait(fetch, deadline, cancelled).await?;
        let count = items.Size().ok()?;
        let paths = (0..count)
            .filter_map(|i| {
                let path = items.GetAt(i).ok()?.Path().ok()?;
                Some(PathBuf::from(path.to_os_string()))
            })
            .collect();
        (count, paths)
    };
    if count == 0 {
        // A disabled index and a completed index with zero hits are different
        // user-visible states. Do not label an unindexed drive a healthy search.
        let state = wait(index_state.0.take()?, deadline, cancelled).await?;
        if !matches!(
            state,
            IndexedState::PartiallyIndexed | IndexedState::FullyIndexed
        ) {
            return None;
        }
    }
    Some((paths, count as usize == remaining))
}

pub(super) async fn lookup(query: &str, cancelled: &AtomicBool) -> Result<Indexed, String> {
    let mut indexed = Indexed::unavailable();
    // Double quotes, wildcards and path separators cannot occur in a Windows
    // filename. Avoid interpreting user characters as executable AQS syntax.
    if query.contains(['"', '*', '?', '/', '\\', ':', '<', '>', '|']) {
        return Ok(indexed);
    }
    let deadline = Instant::now() + Duration::from_millis(850);
    let options = QueryOptions::new().and_then(|options| {
        options.SetFolderDepth(FolderDepth::Deep)?;
        options.SetIndexerOption(IndexerOption::OnlyUseIndexer)?;
        let mut wildcard = "*".to_owned();
        for c in query.chars() {
            wildcard.push(c);
            wildcard.push('*');
        }
        options.SetApplicationSearchFilter(&HSTRING::from(format!(
            "System.FileName:~\"{wildcard}\""
        )))?;
        Ok(options)
    });
    let Ok(options) = options else {
        return Ok(indexed);
    };
    let mask = fixed_drive_mask();
    for i in (0..26).filter(|i| mask & (1 << i) != 0) {
        check_cancelled(cancelled)?;
        if Instant::now() >= deadline || indexed.paths.len() >= MAX_CANDIDATES {
            indexed.limited = true;
            break;
        }
        let remaining = MAX_CANDIDATES - indexed.paths.len();
        if let Some((paths, limited)) =
            query_drive(b'A' + i, &options, remaining, deadline, cancelled).await
        {
            indexed.provider = Provider::WindowsSearch;
            indexed.paths.extend(paths);
            indexed.limited |= limited;
        } else {
            indexed.limited = true;
        }
    }
    check_cancelled(cancelled)?;
    Ok(indexed)
}
