import { invoke } from "@tauri-apps/api/core";
import type { AppProxyConfig } from "./ipc";

export type BackupProviderKind = "local" | "feishu" | "s3" | "google_drive" | "onedrive" | "sftp";
export interface BackupTarget {
  id: string;
  name: string;
  kind: BackupProviderKind;
  enabled: boolean;
  connectionId: string | null;
  rootToken: string;
  proxy: { mode: "app" | "custom" | "none"; custom: AppProxyConfig };
  source: { kind: string; schemaVersion: number; scope: string; customOptions: null };
  writesPaused: boolean;
}
export interface BackupControlConfig {
  formatVersion: number;
  device: { id: string; name: string };
  targets: BackupTarget[];
  connections: FeishuConnection[];
  selectedTargetIds: string[];
}
export interface FeishuConnection {
  id: string;
  appId: string;
  label: string;
  origin: string;
  accountId: string;
  accountName: string;
  tenantKey: string;
  registrationPending: boolean;
}
export interface AuthorizationSession {
  id: string;
  targetId: string;
  revision: number;
  createdAt: number;
  phase: string;
  verificationUrl: string | null;
  userCode: string | null;
  error: string | null;
}
export interface FeishuApplication { appId: string; label: string; isDefault: boolean }
export interface RemoteBackup {
  targetId: string;
  deviceId: string;
  deviceName: string;
  sourceKind: string;
  fileToken: string;
  name: string;
  modifiedAt: string;
}
export interface BackupJob {
  id: string;
  revision: number;
  targetId: string;
  operation: string;
  phase: string;
  bytes: number;
  total: number | null;
  error: string | null;
  artifact: { path: string; size: number; sha256: string } | null;
  remote: RemoteBackup | null;
  createdAt: number;
  updatedAt?: number;
  attempts?: number;
  nextRetryAt?: number | null;
  failureKind?: string | null;
}
export interface RemoteConfiguration {
  config: BackupControlConfig;
  statuses: { targetId: string; connected: boolean; passwordConfigured: boolean }[];
  cache?: { usedBytes: number; limitBytes: number; retentionDays: number };
}
export const remoteBackup = {
  runSelected: (scope: string) => invoke<{ targetId: string; jobId: string | null; localPath: string | null; error: string | null }[]>("backup_run_selected", { scope }),
  config: () => invoke<RemoteConfiguration>("backup_remote_get_config"),
  save: (config: BackupControlConfig, targetId?: string, archivePassword?: string) => invoke<void>("backup_remote_save_config", { config, targetId: targetId ?? null, archivePassword: archivePassword || null }),
  applications: () => invoke<FeishuApplication[]>("backup_feishu_apps"),
  authorize: (targetId: string, applicationSelection?: string, restartApplication = false) => invoke<AuthorizationSession>("backup_feishu_authorize", { targetId, applicationSelection: applicationSelection || null, restartApplication }),
  cleanCache: () => invoke("backup_remote_clean_cache"),
  discard: (jobId: string) => invoke("backup_remote_discard", { jobId }),
  authorizations: () => invoke<AuthorizationSession[]>("backup_feishu_authorization_status"),
  cancelAuthorization: (sessionId: string) => invoke<void>("backup_feishu_authorization_cancel", { sessionId }),
  list: (targetId: string) => invoke<RemoteBackup[]>("backup_remote_list", { targetId }),
  start: (targetId: string) => invoke<string>("backup_remote_start", { targetId }),
  download: (remote: RemoteBackup) => invoke<string>("backup_remote_download", { remote }),
  jobs: () => invoke<BackupJob[]>("backup_remote_jobs"),
  cancel: (jobId: string) => invoke<void>("backup_remote_cancel", { jobId }),
  retry: (jobId: string) => invoke<string>("backup_remote_retry", { jobId }),
  history: (remote: RemoteBackup) => invoke<string>("backup_remote_history_url", { remote }),
};

export function newFeishuTarget(): BackupTarget {
  return {
    id: crypto.randomUUID(), name: "Feishu", kind: "feishu", enabled: false,
    connectionId: null, rootToken: "", writesPaused: false,
    source: { kind: "taomni", schemaVersion: 1, scope: "core", customOptions: null },
    proxy: { mode: "app", custom: { enabled: true, mode: "manual", session_id: "", kind: "http", host: "", port: 3128, username: "", password_ref: "" } },
  };
}
