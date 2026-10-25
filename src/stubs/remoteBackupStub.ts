// Browser-only model for renderer workflows; never evidence of native networking.
import type { BackupPolicy } from "../lib/backup";
import type { BackupSettingsSnapshot, ControlPatch, SettingsEdit } from "../lib/backupSettings";
import { globalRange } from "../lib/backupSettings";
import type { BackupJob, RemoteConfiguration, AuthorizationSession, BackupControlConfig, RemoteBackup } from "../lib/remoteBackup";

const key = "taomni.qa.backup.v1";
type State = { config: RemoteConfiguration; jobs: BackupJob[]; sessions: AuthorizationSession[]; files: RemoteBackup[] };
function load(): State {
  const saved = localStorage.getItem(key);
  if (saved) return JSON.parse(saved) as State;
  return { config: { config: { formatVersion: 1, device: { id: crypto.randomUUID(), name: "Browser preview" }, targets: [], connections: [], selectedTargetIds: ["local"] }, statuses: [], cache: { usedBytes: 0, limitBytes: 2147483648, retentionDays: 7 } }, jobs: [], sessions: [], files: [] };
}
export async function remoteBackupStub(cmd: string, args: Record<string, any> = {}): Promise<unknown> {
  const state = load();
  const config = state.config.config;
  config.settingsRevision ??= 0;
  config.targets.forEach((t) => t.rangeMode ??= "custom");
  const policy: BackupPolicy = JSON.parse(localStorage.getItem("taomni.backup.policy") || JSON.stringify({ autoBackupEnabled: false, frequency: "weekly", maxRetainedCopies: 7, defaultScope: "core", includeMail: null, localChannelEnabled: true, settingsRevision: 0 }));
  const snapshot = (): BackupSettingsSnapshot => ({ policy, remote: state.config, revisions: { policy: policy.settingsRevision ?? 0, control: config.settingsRevision ?? 0 } });

  let result: unknown;
  switch (cmd) {
    case "backup_settings_get": return snapshot();
    case "backup_settings_patch": {
      const failures = Number(localStorage.getItem("taomni.qa.backup.failSaves") || 0);
      if (failures > 0) {
        localStorage.setItem("taomni.qa.backup.failSaves", String(failures - 1));
        throw new Error("BACKUP_STORAGE: Simulated settings write failure");
      }
      const request = args.request as SettingsEdit & { expectedRevision: number };
      if (request.expectedRevision !== snapshot().revisions[request.domain]) throw new Error("BACKUP_CONFIG_CONFLICT");
      if (request.domain === "policy") {
        Object.assign(policy, request.patch, { settingsRevision: (policy.settingsRevision ?? 0) + 1 });
        localStorage.setItem("taomni.backup.policy", JSON.stringify(policy));
      } else {
        const patch: ControlPatch = request.patch;
        switch (patch.op) {
          case "setDeviceName": config.device.name = patch.name; break;
          case "setSelectedTargets": config.selectedTargetIds = patch.ids; break;
          case "addTarget": config.targets.push({ ...patch.target, rangeMode: "inherit", enabled: false }); break;
          case "updateTarget": config.targets = config.targets.map((t) => t.id === patch.targetId ? { ...t, ...patch.fields } : t); break;
          case "removeTarget": config.targets = config.targets.filter((t) => t.id !== patch.targetId); config.selectedTargetIds = config.selectedTargetIds.filter((id) => id !== patch.targetId); break;
        }
        config.settingsRevision!++;
      }
      result = snapshot(); break;
    }
    case "backup_target_set_password": {
      if (!args.password?.trim()) throw new Error("Backup password cannot be empty");
      state.config.statuses = [...state.config.statuses.filter((s) => s.targetId !== args.targetId), { targetId: args.targetId, connected: state.config.statuses.some((s) => s.targetId === args.targetId && s.connected), passwordConfigured: true }];
      result = snapshot(); break;
    }
    case "backup_run_manual": {
      const request = args.request;
      if (request.expectedPolicyRevision !== snapshot().revisions.policy || request.expectedControlRevision !== snapshot().revisions.control) throw new Error("BACKUP_CONFIG_CONFLICT");
      const ids: string[] = request.destination.kind === "file" ? ["local"] : config.selectedTargetIds;
      result = ids.map((targetId) => {
        const jobId = targetId === "local" ? null : crypto.randomUUID();
        if (jobId) state.jobs.push({ id: jobId, targetId, revision: 1, operation: "upload", phase: "completed", bytes: 128, total: 128, error: null, artifact: null, remote: null, createdAt: Date.now() });
        return { targetId, jobId, localPath: jobId ? null : request.destination.path ?? "/preview/backups/manual.taobak", error: null };
      });
      localStorage.setItem("taomni.qa.backup.lastManual", JSON.stringify({ range: globalRange(policy), destinationIds: ids }));
      break;
    }
    case "backup_feishu_authorization_forget": {
      state.sessions = state.sessions.map((s) => s.id === args.sessionId ? { ...s, revision: s.revision + 1, dismissedAt: Date.now(), verificationUrl: null, userCode: null, error: null } : s);
      result = state.sessions.find((s) => s.id === args.sessionId); break;
    }
    case "backup_remote_resume_writes": config.targets = config.targets.map((t) => t.id === args.targetId ? { ...t, writesPaused: false } : t); break;
    case "backup_remote_get_config": return state.config;
    case "backup_remote_jobs": return state.jobs;
    case "backup_feishu_apps": return [];
    case "backup_feishu_authorization_status": return state.sessions;
    case "backup_remote_list": return state.files;
    case "backup_remote_save_config": {
      state.config.config = args.config as BackupControlConfig;
      state.config.statuses = state.config.config.targets.map(t => ({ targetId: t.id, connected: state.config.statuses.find(s => s.targetId === t.id)?.connected ?? false, passwordConfigured: !!args.archivePassword || !!state.config.statuses.find(s => s.targetId === t.id)?.passwordConfigured }));
      break;
    }
    case "backup_feishu_authorize": {
      const session: AuthorizationSession = { id: crypto.randomUUID(), targetId: args.targetId, revision: 1, createdAt: Date.now(), phase: "failed", cleanupComplete: true, cancelRequested: false, dismissedAt: null, verificationUrl: null, userCode: null, error: "BACKUP_REGISTRATION_RECOVERY: Browser fixture; native authorization is not available" };
      state.sessions = [session]; result = session; break;
    }
    case "backup_feishu_authorization_cancel": state.sessions = state.sessions.map(s => s.id === args.sessionId ? { ...s, phase: "cancelled", cleanupComplete: true, cancelRequested: true, verificationUrl: null, userCode: null, revision: s.revision + 1 } : s); break;
    case "backup_remote_cancel": state.jobs = state.jobs.map(j => j.id === args.jobId ? { ...j, phase: "cancelled", nextRetryAt: null, revision: j.revision + 1 } : j); break;
    case "backup_remote_retry": state.jobs = state.jobs.map(j => j.id === args.jobId ? { ...j, phase: "completed", error: null, nextRetryAt: null, revision: j.revision + 1 } : j); result = args.jobId; break;
    case "backup_remote_discard": state.jobs = state.jobs.map(j => j.id === args.jobId ? { ...j, phase: "discarded", nextRetryAt: null, artifact: null, revision: j.revision + 1 } : j); break;
    case "backup_remote_clean_cache": state.jobs = state.jobs.map(j => j.phase === "completed" ? { ...j, artifact: null, revision: j.revision + 1 } : j); state.config.cache = { usedBytes: 128, limitBytes: 2147483648, retentionDays: 7 }; break;
    case "backup_remote_history_url": state.config.config.targets = state.config.config.targets.map(t => t.id === args.remote.targetId ? { ...t, writesPaused: true } : t); result = "https://my.feishu.cn/file/qa_fixture"; break;
    default: throw new Error("Browser preview does not implement this cloud operation");
  }
  localStorage.setItem(key, JSON.stringify(state));
  return result;
}
