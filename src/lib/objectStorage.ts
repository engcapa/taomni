// IPC wrappers + event listeners for the object-storage feature. Mirrors
// `lib/sftp.ts`. Transfer progress/complete events reuse the SFTP payload
// shapes (the backend emits identical structures on `storage-*` channels).

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { withVaultLockedNotice, type SessionConfig } from "./ipc";
import { parseSessionOptions } from "./terminalProfile";
import { normalizeNetworkSettings, toNetworkSettingsPayload } from "./networkSettings";
import { normalizeObjectStorageConfig } from "../types/objectStorage";
import type {
  BucketEntry,
  ObjectListPage,
  ObjectMetadata,
  ObjectStorageConfig,
  ObjectStorageProvider,
} from "../types/objectStorage";
import type { TransferCompletePayload, TransferProgressPayload } from "./sftp";

/** Secret-bearing config keys, stored in `options_json` as `vault:` refs. */
const OSS_SECRET_KEYS = [
  "secretAccessKey",
  "sessionToken",
  "accountKey",
  "connectionString",
  "sasToken",
  "azureBearerToken",
] as const;

/**
 * Build an {@link ObjectStorageConfig} from a saved S3/AzureBlob session. All
 * fields (including `vault:` secret refs) live in `options_json` under the keys
 * the editor writes; the backend resolves vault refs on attach.
 */
export function sessionToObjectStorageConfig(session: SessionConfig): ObjectStorageConfig {
  const o = parseSessionOptions(session.options_json);
  const str = (k: string): string | null => (typeof o[k] === "string" ? (o[k] as string) : null);
  const bool = (k: string): boolean | null => (typeof o[k] === "boolean" ? (o[k] as boolean) : null);
  const provider =
    (str("provider") as ObjectStorageProvider | null) ??
    (session.session_type === "AzureBlob" ? "azure" : "aws");
  // Route through the per-session network settings (proxy / SSH jump) when one
  // is configured; otherwise leave `network` unset so the backend falls back to
  // the app-level global proxy.
  const ns = normalizeNetworkSettings(o.networkSettings);
  const network =
    ns.proxyKind && ns.proxyKind !== "none" ? toNetworkSettingsPayload(ns) : null;
  return normalizeObjectStorageConfig({
    provider,
    endpoint: str("endpoint"),
    region: str("region"),
    pathStyle: bool("pathStyle"),
    accessKeyId: str("accessKeyId"),
    secretAccessKey: str("secretAccessKey"),
    sessionToken: str("sessionToken"),
    defaultBucket: str("defaultBucket"),
    awsAuth: (str("awsAuth") as ObjectStorageConfig["awsAuth"]) ?? null,
    awsProfile: str("awsProfile"),
    accountName: str("accountName"),
    accountKey: str("accountKey"),
    connectionString: str("connectionString"),
    sasToken: str("sasToken"),
    endpointSuffix: str("endpointSuffix"),
    defaultContainer: str("defaultContainer"),
    azureAuth: (str("azureAuth") as ObjectStorageConfig["azureAuth"]) ?? null,
    azureBearerToken: str("azureBearerToken"),
    network,
    storageClass: str("storageClass"),
  });
}

/** True if any object-storage secret in the session is a locked `vault:` ref. */
export function objectStorageHasVaultSecret(session: SessionConfig): boolean {
  const o = parseSessionOptions(session.options_json);
  return OSS_SECRET_KEYS.some((k) => typeof o[k] === "string" && (o[k] as string).startsWith("vault:"));
}

export async function storageAttach(
  sessionId: string,
  config: ObjectStorageConfig,
): Promise<void> {
  return withVaultLockedNotice(() =>
    invoke("storage_attach", { sessionId, config: normalizeObjectStorageConfig(config) }),
  );
}

export async function storageDetach(sessionId: string): Promise<void> {
  return invoke("storage_detach", { sessionId });
}

export async function storagePing(sessionId: string): Promise<void> {
  return invoke("storage_ping", { sessionId });
}

export async function storageTestConnection(
  config: ObjectStorageConfig,
): Promise<void> {
  return withVaultLockedNotice(() =>
    invoke("storage_test_connection", { config: normalizeObjectStorageConfig(config) }),
  );
}

export async function storageListBuckets(sessionId: string): Promise<BucketEntry[]> {
  return invoke<BucketEntry[]>("storage_list_buckets", { sessionId });
}

export async function storageListObjects(
  sessionId: string,
  bucket: string,
  prefix: string,
  continuation: string | null = null,
): Promise<ObjectListPage> {
  return invoke<ObjectListPage>("storage_list_objects", {
    sessionId,
    bucket,
    prefix,
    continuation,
  });
}

export async function storageDeleteObject(
  sessionId: string,
  bucket: string,
  key: string,
): Promise<void> {
  return invoke("storage_delete_object", { sessionId, bucket, key });
}

export async function storageDeletePrefix(
  sessionId: string,
  bucket: string,
  prefix: string,
): Promise<void> {
  return invoke("storage_delete_prefix", { sessionId, bucket, prefix });
}

export async function storageCreateFolder(
  sessionId: string,
  bucket: string,
  prefix: string,
): Promise<void> {
  return invoke("storage_create_folder", { sessionId, bucket, prefix });
}

export async function storageCreateBucket(sessionId: string, bucket: string): Promise<void> {
  return invoke("storage_create_bucket", { sessionId, bucket });
}

export async function storageDeleteBucket(sessionId: string, bucket: string): Promise<void> {
  return invoke("storage_delete_bucket", { sessionId, bucket });
}

export async function storageHeadObject(
  sessionId: string,
  bucket: string,
  key: string,
): Promise<ObjectMetadata> {
  return invoke<ObjectMetadata>("storage_head_object", { sessionId, bucket, key });
}

export async function storageCopyObject(
  sessionId: string,
  srcBucket: string,
  srcKey: string,
  dstBucket: string,
  dstKey: string,
): Promise<void> {
  return invoke("storage_copy_object", { sessionId, srcBucket, srcKey, dstBucket, dstKey });
}

export async function storageMoveObject(
  sessionId: string,
  srcBucket: string,
  srcKey: string,
  dstBucket: string,
  dstKey: string,
): Promise<void> {
  return invoke("storage_move_object", { sessionId, srcBucket, srcKey, dstBucket, dstKey });
}

export async function storageMovePrefix(
  sessionId: string,
  bucket: string,
  oldPrefix: string,
  newPrefix: string,
): Promise<void> {
  return invoke("storage_move_prefix", { sessionId, bucket, oldPrefix, newPrefix });
}

export async function storageShareUrl(
  sessionId: string,
  bucket: string,
  key: string,
  ttlSecs: number,
): Promise<string> {
  return invoke<string>("storage_share_url", { sessionId, bucket, key, ttlSecs });
}

export async function storageDownload(
  sessionId: string,
  transferId: string,
  bucket: string,
  key: string,
  localPath: string,
): Promise<void> {
  return invoke("storage_download", { sessionId, transferId, bucket, key, localPath });
}

export async function storageUpload(
  sessionId: string,
  transferId: string,
  bucket: string,
  key: string,
  localPath: string,
  storageClass?: string | null,
): Promise<void> {
  return invoke("storage_upload", {
    sessionId,
    transferId,
    bucket,
    key,
    localPath,
    storageClass: storageClass || null,
  });
}

export async function storageCancelTransfer(transferId: string): Promise<void> {
  return invoke("storage_cancel_transfer", { transferId });
}

export async function storagePauseTransfer(transferId: string): Promise<void> {
  return invoke("storage_pause_transfer", { transferId });
}

export async function storageResumeTransfer(transferId: string): Promise<void> {
  return invoke("storage_resume_transfer", { transferId });
}

export function listenStorageProgress(
  transferId: string,
  cb: (payload: TransferProgressPayload) => void,
): Promise<UnlistenFn> {
  return listen<TransferProgressPayload>(`storage-progress-${transferId}`, (e) => cb(e.payload));
}

export function listenStoragePaused(
  transferId: string,
  cb: (payload: TransferProgressPayload) => void,
): Promise<UnlistenFn> {
  return listen<TransferProgressPayload>(`storage-paused-${transferId}`, (e) => cb(e.payload));
}

export function listenStorageComplete(
  transferId: string,
  cb: (payload: TransferCompletePayload) => void,
): Promise<UnlistenFn> {
  return listen<TransferCompletePayload>(
    `storage-transfer-complete-${transferId}`,
    (e) => cb(e.payload),
  );
}
