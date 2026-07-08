//! A live object-storage connection held in `AppState::oss_sessions`, with
//! engine-agnostic dispatch over the S3 and Azure backends.

use std::path::Path;
use std::sync::Arc;

use tauri::{AppHandle, Runtime};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::azure::AzureClient;
use super::s3::S3Client;
use super::types::{BucketEntry, ObjectListPage, ObjectMetadata};
use crate::filebrowser::transfer::TransferHandle;

fn clean_storage_class(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

/// Per-engine client handle.
pub enum OssHandle {
    S3(S3Client),
    Azure(AzureClient),
}

/// A live object-storage connection, keyed by the frontend session id.
pub struct ObjectStorageSession {
    pub session_id: String,
    pub handle: OssHandle,
    /// Default bucket (S3) or container (Azure) to open into, if configured.
    pub default_location: Option<String>,
    /// Cancels in-flight list/transfer operations when the session is detached.
    pub cancel: CancellationToken,
    /// Loopback forwarder task when the session routes through an SSH jump host
    /// (P7). Aborted on close to release the bound local port and bridges.
    pub forward_task: Option<JoinHandle<()>>,
    /// Default storage class / access tier for uploads when the caller doesn't
    /// pass one (P8).
    pub default_storage_class: Option<String>,
}

impl ObjectStorageSession {
    /// Signal any in-flight operations on this session to stop.
    pub fn close(&self) {
        self.cancel.cancel();
        if let Some(task) = &self.forward_task {
            task.abort();
        }
    }

    pub async fn list_buckets(&self) -> Result<Vec<BucketEntry>, String> {
        match &self.handle {
            OssHandle::S3(c) => c.list_buckets().await,
            OssHandle::Azure(c) => c.list_buckets().await,
        }
    }

    pub async fn list_objects(
        &self,
        bucket: &str,
        prefix: &str,
        continuation: Option<&str>,
        max_keys: usize,
    ) -> Result<ObjectListPage, String> {
        match &self.handle {
            OssHandle::S3(c) => c.list_objects(bucket, prefix, continuation, max_keys).await,
            OssHandle::Azure(c) => c.list_objects(bucket, prefix, continuation, max_keys).await,
        }
    }

    pub async fn get_object_bytes(&self, bucket: &str, key: &str) -> Result<Vec<u8>, String> {
        match &self.handle {
            OssHandle::S3(c) => c.get_object_bytes(bucket, key).await,
            OssHandle::Azure(c) => c.get_object_bytes(bucket, key).await,
        }
    }

    pub async fn put_object_bytes(
        &self,
        bucket: &str,
        key: &str,
        data: Vec<u8>,
    ) -> Result<(), String> {
        match &self.handle {
            OssHandle::S3(c) => c.put_object_bytes(bucket, key, data).await,
            OssHandle::Azure(c) => c.put_object_bytes(bucket, key, data).await,
        }
    }

    pub async fn delete_object(&self, bucket: &str, key: &str) -> Result<(), String> {
        match &self.handle {
            OssHandle::S3(c) => c.delete_object(bucket, key).await,
            OssHandle::Azure(c) => c.delete_object(bucket, key).await,
        }
    }

    /// Recursively delete everything under `prefix` (a "folder").
    pub async fn delete_prefix(&self, bucket: &str, prefix: &str) -> Result<(), String> {
        match &self.handle {
            OssHandle::S3(c) => c.delete_prefix(bucket, prefix).await,
            OssHandle::Azure(c) => c.delete_prefix(bucket, prefix).await,
        }
    }

    pub async fn head_object(&self, bucket: &str, key: &str) -> Result<ObjectMetadata, String> {
        match &self.handle {
            OssHandle::S3(c) => c.head_object(bucket, key).await,
            OssHandle::Azure(c) => c.head_object(bucket, key).await,
        }
    }

    pub async fn copy_object(
        &self,
        src_bucket: &str,
        src_key: &str,
        dst_bucket: &str,
        dst_key: &str,
    ) -> Result<(), String> {
        match &self.handle {
            OssHandle::S3(c) => {
                c.copy_object(src_bucket, src_key, dst_bucket, dst_key)
                    .await
            }
            OssHandle::Azure(c) => {
                c.copy_object(src_bucket, src_key, dst_bucket, dst_key)
                    .await
            }
        }
    }

    /// Rename/move = server-side copy then delete the source.
    pub async fn move_object(
        &self,
        src_bucket: &str,
        src_key: &str,
        dst_bucket: &str,
        dst_key: &str,
    ) -> Result<(), String> {
        self.copy_object(src_bucket, src_key, dst_bucket, dst_key)
            .await?;
        self.delete_object(src_bucket, src_key).await
    }

    /// Build a shareable read-only URL (presigned for S3, service SAS for Azure).
    pub fn presign_get(&self, bucket: &str, key: &str, ttl_secs: u64) -> Result<String, String> {
        match &self.handle {
            OssHandle::S3(c) => c.presign_get(bucket, key, ttl_secs),
            OssHandle::Azure(c) => c.presign_get(bucket, key, ttl_secs),
        }
    }

    pub async fn download_to_file<R: Runtime>(
        &self,
        bucket: &str,
        key: &str,
        dest: &Path,
        transfer_id: &str,
        handle: &Arc<TransferHandle>,
        app: &AppHandle<R>,
    ) -> Result<(), String> {
        match &self.handle {
            OssHandle::S3(c) => {
                c.download_to_file(bucket, key, dest, transfer_id, handle, app)
                    .await
            }
            OssHandle::Azure(c) => {
                c.download_to_file(bucket, key, dest, transfer_id, handle, app)
                    .await
            }
        }
    }

    pub async fn upload_from_file<R: Runtime>(
        &self,
        local: &Path,
        bucket: &str,
        key: &str,
        storage_class: Option<&str>,
        transfer_id: &str,
        handle: &Arc<TransferHandle>,
        app: &AppHandle<R>,
    ) -> Result<(), String> {
        // Per-upload override, else the session's configured default.
        let sc = clean_storage_class(storage_class)
            .or_else(|| clean_storage_class(self.default_storage_class.as_deref()));
        match &self.handle {
            OssHandle::S3(c) => {
                c.upload_from_file(local, bucket, key, sc, transfer_id, handle, app)
                    .await
            }
            OssHandle::Azure(c) => {
                c.upload_from_file(local, bucket, key, sc, transfer_id, handle, app)
                    .await
            }
        }
    }

    pub async fn create_folder(&self, bucket: &str, prefix: &str) -> Result<(), String> {
        match &self.handle {
            OssHandle::S3(c) => c.create_folder(bucket, prefix).await,
            OssHandle::Azure(c) => c.create_folder(bucket, prefix).await,
        }
    }

    pub async fn create_bucket(&self, bucket: &str) -> Result<(), String> {
        match &self.handle {
            OssHandle::S3(c) => c.create_bucket(bucket).await,
            OssHandle::Azure(c) => c.create_bucket(bucket).await,
        }
    }

    pub async fn delete_bucket(&self, bucket: &str) -> Result<(), String> {
        match &self.handle {
            OssHandle::S3(c) => c.delete_bucket(bucket).await,
            OssHandle::Azure(c) => c.delete_bucket(bucket).await,
        }
    }

    pub async fn ping(&self) -> Result<(), String> {
        let default = self.default_location.as_deref();
        match &self.handle {
            OssHandle::S3(c) => c.ping(default).await,
            OssHandle::Azure(c) => c.ping(default).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_storage_class_ignores_empty_values() {
        assert_eq!(clean_storage_class(None), None);
        assert_eq!(clean_storage_class(Some("")), None);
        assert_eq!(clean_storage_class(Some("   ")), None);
        assert_eq!(clean_storage_class(Some(" STANDARD ")), Some("STANDARD"));
    }
}
