pub mod auth;
mod auth_connect;
mod auth_service;
mod auth_session;
pub mod cli_config;
mod cli_secret;
mod device_flow;
mod naming;
pub(crate) mod request;
use super::{
    control,
    manifest::file_sha256,
    model::*,
    provider::{DestinationProvider, TransferContext},
    transfer,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

const SMALL_LIMIT: u64 = 20 * 1024 * 1024;

pub struct FeishuProvider {
    pub app: tauri::AppHandle,
    pub client: reqwest::Client,
    pub bearer: tokio::sync::Mutex<String>,
    pub target: BackupTarget,
    pub base: String,
}
#[derive(Clone, Deserialize)]
struct FileEntry {
    token: String,
    name: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    modified_time: String,
}
#[derive(Serialize, Deserialize)]
struct UploadCheckpoint {
    sha256: String,
    parent: String,
    existing: Option<String>,
    upload_id: String,
    block_size: u64,
    block_num: u64,
    next: u64,
}

impl FeishuProvider {
    async fn send<F: Fn() -> reqwest::RequestBuilder>(
        &self,
        build: F,
        read_only: bool,
        ctx: &TransferContext,
    ) -> Result<Value, String> {
        let bearer = self.bearer.lock().await.clone();
        let result = request::json(
            |token| build().bearer_auth(token),
            bearer,
            |rejected| self.refresh(rejected, ctx),
            read_only,
            ctx,
        )
        .await;
        if result.as_ref().err().is_some_and(|e| {
            super::failure::classify(e) == super::failure::FailureKind::Authorization
        }) {
            auth::require_authorization(&self.app, &self.target, &ctx.cancel).await?;
        }
        result
    }

    async fn refresh(&self, rejected: String, ctx: &TransferContext) -> Result<String, String> {
        let token = auth::access_token_after_rejection(
            &self.app,
            &self.target,
            &self.client,
            &ctx.cancel,
            &rejected,
        )
        .await?;
        *self.bearer.lock().await = token.clone();
        Ok(token)
    }

    async fn download_file(
        &self,
        token: &str,
        path: &Path,
        ctx: &TransferContext,
    ) -> Result<(), String> {
        let bearer = self.bearer.lock().await.clone();
        let result = transfer::download_with_refresh(
            &self.client,
            &format!("{}/files/{token}/download", self.base),
            &bearer,
            token,
            path,
            ctx,
            |rejected| self.refresh(rejected, ctx),
        )
        .await;
        if result.as_ref().err().is_some_and(|e| {
            super::failure::classify(e) == super::failure::FailureKind::Authorization
        }) {
            auth::require_authorization(&self.app, &self.target, &ctx.cancel).await?;
        }
        result
    }
    async fn children(
        &self,
        folder: &str,
        ctx: &TransferContext,
    ) -> Result<Vec<FileEntry>, String> {
        if !folder.is_empty() {
            validate_token(folder)?;
        }
        let mut entries = Vec::new();
        let mut cursor = String::new();
        let mut seen = std::collections::HashSet::new();
        loop {
            let value = self
                .send(
                    || {
                        self.client.get(format!("{}/files", self.base)).query(&[
                            ("folder_token", folder),
                            ("page_size", "200"),
                            ("page_token", &cursor),
                        ])
                    },
                    true,
                    ctx,
                )
                .await?;
            let files: Vec<FileEntry> = serde_json::from_value(value["data"]["files"].clone())
                .map_err(|_| "Invalid Feishu file list")?;
            entries.extend(files);
            if value["data"]["has_more"].as_bool() != Some(true) {
                break;
            }
            cursor = value["data"]["next_page_token"]
                .as_str()
                .or_else(|| value["data"]["page_token"].as_str())
                .ok_or("Missing Feishu page cursor")?
                .into();
            if !seen.insert(cursor.clone()) || entries.len() > 100_000 {
                return Err("Invalid or excessive Feishu pagination".into());
            }
        }
        Ok(entries)
    }
    async fn folder(
        &self,
        parent: &str,
        name: &str,
        ctx: &TransferContext,
    ) -> Result<String, String> {
        let matching: Vec<_> = self
            .children(parent, ctx)
            .await?
            .into_iter()
            .filter(|f| f.name == name)
            .collect();
        if matching.len() > 1 || matching.first().is_some_and(|f| f.kind != "folder") {
            return Err(
                "Ambiguous backup folder; resolve duplicate names in Feishu before continuing"
                    .into(),
            );
        }
        if let Some(folder) = matching.first() {
            return Ok(folder.token.clone());
        }
        let result = self
            .send(
                || {
                    self.client
                        .post(format!("{}/files/create_folder", self.base))
                        .json(&json!({"folder_token":parent,"name":name}))
                },
                false,
                ctx,
            )
            .await?;
        let token = result["data"]["token"]
            .as_str()
            .ok_or("Missing new folder token")?
            .to_owned();
        validate_token(&token)?;
        Ok(token)
    }
    async fn named_folder(
        &self,
        parent: &str,
        id: &str,
        label: &str,
        ctx: &TransferContext,
    ) -> Result<String, String> {
        let title = naming::title(label, id)?;
        let entries = self.children(parent, ctx).await?;
        let matches: Vec<_> = entries
            .iter()
            .filter(|f| naming::parse(&f.name).is_some_and(|(found, _)| found == id))
            .collect();
        if matches.len() > 1 || matches.first().is_some_and(|f| f.kind != "folder") {
            return Err(
                "Ambiguous backup folder identity; resolve duplicate folders in Feishu".into(),
            );
        }
        if let Some(folder) = matches.first() {
            validate_token(&folder.token)?;
            if folder.name != title {
                self.send(
                    || {
                        self.client
                            .patch(format!("{}/files/{}", self.base, folder.token))
                            .query(&[("type", "folder")])
                            .json(&json!({"new_title":title}))
                    },
                    false,
                    ctx,
                )
                .await?;
            }
            return Ok(folder.token.clone());
        }
        self.folder(parent, &title, ctx).await
    }
    async fn small_upload(
        &self,
        parent: &str,
        name: &str,
        bytes: Vec<u8>,
        existing: Option<&str>,
        ctx: &TransferContext,
    ) -> Result<Receipt, String> {
        let sha = super::manifest::bytes_sha256(&bytes);
        let build = || {
            let mut form = reqwest::multipart::Form::new()
                .text("file_name", name.to_owned())
                .text("parent_type", "explorer")
                .text("parent_node", parent.to_owned())
                .text("size", bytes.len().to_string())
                .part(
                    "file",
                    reqwest::multipart::Part::bytes(bytes.clone()).file_name(name.to_owned()),
                );
            if let Some(token) = existing {
                form = form.text("file_token", token.to_owned());
            }
            self.client
                .post(format!("{}/files/upload_all", self.base))
                .multipart(form)
        };
        let result = self.send(build, false, ctx).await?;
        let token = result["data"]["file_token"]
            .as_str()
            .ok_or("Missing upload file token")?
            .to_owned();
        let version = result["data"]
            .get("version")
            .filter(|v| !v.is_null())
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| v.to_string())
            });
        if existing.is_some_and(|old| old != token) || (existing.is_some() && version.is_none()) {
            return Err("FEISHU_NATIVE_VERSION_UNSUPPORTED: overwrite was not confirmed; the original backup remains selected".into());
        }
        Ok(Receipt {
            file_token: token,
            version,
            sha256: sha,
        })
    }
    async fn probe(&self, parent: &str, ctx: &TransferContext) -> Result<(), String> {
        // Probe only disposable synthetic bytes, never a user's sole backup.
        let matches: Vec<_> = self
            .children(parent, ctx)
            .await?
            .into_iter()
            .filter(|f| f.name == ".taomni-version-probe")
            .collect();
        if matches.len() > 1 {
            return Err(
                "Feishu version probe produced duplicate files; native versioning is unavailable"
                    .into(),
            );
        }
        let token = if let Some(file) = matches.first() {
            file.token.clone()
        } else {
            self.small_upload(
                parent,
                ".taomni-version-probe",
                b"Taomni version capability probe v1".to_vec(),
                None,
                ctx,
            )
            .await?
            .file_token
        };
        self.small_upload(
            parent,
            ".taomni-version-probe",
            format!("Taomni probe {}", uuid::Uuid::new_v4()).into_bytes(),
            Some(&token),
            ctx,
        )
        .await?;
        Ok(())
    }
    async fn multipart(
        &self,
        artifact: &Artifact,
        parent: &str,
        existing: Option<&str>,
        checkpoint: &Path,
        ctx: &TransferContext,
    ) -> Result<Receipt, String> {
        let previous: Option<UploadCheckpoint> = std::fs::read(checkpoint)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok());
        let mut progress = if let Some(p) = previous.filter(|p| {
            p.sha256 == artifact.sha256 && p.parent == parent && p.existing.as_deref() == existing
        }) {
            p
        } else {
            let mut body = json!({"file_name":"current.taobak", "parent_type":"explorer", "parent_node":parent, "size":artifact.size});
            if let Some(token) = existing {
                body["file_token"] = json!(token);
            }
            let value = self
                .send(
                    || {
                        self.client
                            .post(format!("{}/files/upload_prepare", self.base))
                            .json(&body)
                    },
                    false,
                    ctx,
                )
                .await?;
            UploadCheckpoint {
                sha256: artifact.sha256.clone(),
                parent: parent.into(),
                existing: existing.map(str::to_owned),
                upload_id: value["data"]["upload_id"]
                    .as_str()
                    .ok_or("Missing upload transaction")?
                    .into(),
                block_size: value["data"]["block_size"]
                    .as_u64()
                    .ok_or("Missing upload block size")?,
                block_num: value["data"]["block_num"]
                    .as_u64()
                    .ok_or("Missing upload block count")?,
                next: 0,
            }
        };
        if progress.block_size == 0
            || progress.block_size > 32 * 1024 * 1024
            || progress.block_num != artifact.size.div_ceil(progress.block_size)
            || progress.next > progress.block_num
        {
            return Err("Invalid multipart upload checkpoint".into());
        }
        control::write_json(checkpoint, &progress)?;
        let mut input = tokio::fs::File::open(&artifact.path)
            .await
            .map_err(|e| e.to_string())?;
        input
            .seek(std::io::SeekFrom::Start(
                progress.next * progress.block_size,
            ))
            .await
            .map_err(|e| e.to_string())?;
        while progress.next < progress.block_num {
            ctx.check()?;
            let offset = progress.next * progress.block_size;
            let len = progress.block_size.min(artifact.size - offset);
            let mut bytes = vec![0; len as usize];
            input
                .read_exact(&mut bytes)
                .await
                .map_err(|e| e.to_string())?;
            let build = || {
                let form = reqwest::multipart::Form::new()
                    .text("upload_id", progress.upload_id.clone())
                    .text("seq", progress.next.to_string())
                    .text("size", len.to_string())
                    .part(
                        "file",
                        reqwest::multipart::Part::bytes(bytes.clone()).file_name("block"),
                    );
                self.client
                    .post(format!("{}/files/upload_part", self.base))
                    .multipart(form)
            };
            if let Err(error) = self.send(build, false, ctx).await {
                // Expired upload IDs may be retried by preparing a fresh transaction.
                if error.contains("106") {
                    let _ = std::fs::remove_file(checkpoint);
                }
                return Err(error);
            }
            progress.next += 1;
            control::write_json(checkpoint, &progress)?;
            ctx.progress(
                "uploading",
                (progress.next * progress.block_size).min(artifact.size),
                Some(artifact.size),
            );
        }
        let value = self
            .send(
                || {
                    self.client
                        .post(format!("{}/files/upload_finish", self.base))
                        .json(
                            &json!({"upload_id":progress.upload_id,"block_num":progress.block_num}),
                        )
                },
                false,
                ctx,
            )
            .await?;
        let token = value["data"]["file_token"]
            .as_str()
            .ok_or("Missing completed upload token")?
            .to_owned();
        if existing.is_some_and(|old| old != token) {
            return Err("FEISHU_NATIVE_VERSION_UNSUPPORTED: multipart upload did not preserve file identity".into());
        }
        Ok(Receipt {
            file_token: token,
            version: None,
            sha256: artifact.sha256.clone(),
        })
    }
}

#[async_trait::async_trait]
impl DestinationProvider for FeishuProvider {
    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            current_download: true,
            native_version_upload: true,
            resume_upload: true,
            resume_download: true,
            ..Default::default()
        }
    }
    async fn list(&self, ctx: &TransferContext) -> Result<Vec<RemoteBackup>, String> {
        let roots: Vec<_> = self
            .children(&self.target.root_token, ctx)
            .await?
            .into_iter()
            .filter(|f| f.kind == "folder" && f.name == "taomni-backups-v1")
            .collect();
        if roots.len() > 1 {
            return Err("Duplicate Taomni backup roots".into());
        }
        let Some(root) = roots.first() else {
            return Ok(vec![]);
        };
        let mut result = Vec::new();
        for device in self.children(&root.token, ctx).await? {
            if device.kind != "folder" {
                continue;
            }
            let Some((device_id, device_name)) = naming::parse(&device.name) else {
                continue;
            };
            for plan in self.children(&device.token, ctx).await? {
                if plan.kind != "folder" || naming::parse(&plan.name).is_none() {
                    continue;
                }
                let files = self.children(&plan.token, ctx).await?;
                let current: Vec<_> = files
                    .iter()
                    .filter(|f| f.kind == "file" && f.name == "current.taobak")
                    .collect();
                if current.len() > 1 {
                    return Err(
                        "Ambiguous current backup; duplicate files require reconciliation".into(),
                    );
                }
                if let Some(file) = current.first() {
                    result.push(RemoteBackup {
                        target_id: self.target.id.clone(),
                        device_id: device_id.into(),
                        device_name: device_name.into(),
                        source_kind: "taomni".into(),
                        file_token: file.token.clone(),
                        name: format!("{} / {}", naming::parse(&plan.name).unwrap().1, file.name),
                        modified_at: file.modified_time.clone(),
                    });
                }
            }
        }
        Ok(result)
    }
    async fn upload(
        &self,
        artifact: &Artifact,
        device: &DeviceIdentity,
        checkpoint: &Path,
        ctx: &TransferContext,
    ) -> Result<Receipt, String> {
        validate_id(&device.id)?;
        let root = self
            .folder(&self.target.root_token, "taomni-backups-v1", ctx)
            .await?;
        let device_folder = self
            .named_folder(&root, &device.id, &device.name, ctx)
            .await?;
        let parent = self
            .named_folder(&device_folder, &self.target.id, &self.target.name, ctx)
            .await?;
        self.probe(&parent, ctx).await?;
        let candidates: Vec<_> = self
            .children(&parent, ctx)
            .await?
            .into_iter()
            .filter(|f| f.name == "current.taobak")
            .collect();
        if candidates.len() > 1 || candidates.first().is_some_and(|f| f.kind != "file") {
            return Err("Ambiguous current backup; refusing to overwrite".into());
        }
        let existing = candidates.first().map(|f| f.token.as_str());
        let verification = checkpoint.with_extension("verification.taobak");
        if let Some(token) = existing {
            // Reconcile any previous response lost after a successful commit.
            self.download_file(token, &verification, ctx).await?;
            if file_sha256(&verification).map_err(|e| e.to_string())? == artifact.sha256 {
                let _ = std::fs::remove_file(&verification);
                let _ = std::fs::remove_file(checkpoint);
                return Ok(Receipt {
                    file_token: token.into(),
                    version: None,
                    sha256: artifact.sha256.clone(),
                });
            }
            let _ = std::fs::remove_file(&verification);
        }
        ctx.progress("uploading", 0, Some(artifact.size));
        let receipt = if artifact.size <= SMALL_LIMIT {
            self.small_upload(
                &parent,
                "current.taobak",
                tokio::fs::read(&artifact.path)
                    .await
                    .map_err(|e| e.to_string())?,
                existing,
                ctx,
            )
            .await?
        } else {
            self.multipart(artifact, &parent, existing, checkpoint, ctx)
                .await?
        };
        ctx.progress("verifying", artifact.size, Some(artifact.size));
        self.download_file(&receipt.file_token, &verification, ctx)
            .await?;
        if file_sha256(&verification).map_err(|e| e.to_string())? != artifact.sha256 {
            return Err(
                "Uploaded backup verification failed; keep the local artifact and retry".into(),
            );
        }
        let _ = std::fs::remove_file(&verification);
        let _ = std::fs::remove_file(checkpoint);
        Ok(receipt)
    }
    async fn download(
        &self,
        remote: &RemoteBackup,
        path: &Path,
        ctx: &TransferContext,
    ) -> Result<(), String> {
        validate_token(&remote.file_token)?;
        // The caller supplies an object selected from this target, not arbitrary credentials/URLs.
        if remote.target_id != self.target.id {
            return Err("Backup target mismatch".into());
        }
        if !self
            .list(ctx)
            .await?
            .iter()
            .any(|f| f.file_token == remote.file_token && f.device_id == remote.device_id)
        {
            return Err("Backup file no longer belongs to the selected target/device".into());
        }
        self.download_file(&remote.file_token, path, ctx).await
    }
}
