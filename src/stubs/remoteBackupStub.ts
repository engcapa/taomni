// Browser-only model for renderer workflows; never evidence of native networking.
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
  let result: unknown;
  switch (cmd) {
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
      const session: AuthorizationSession = { id: crypto.randomUUID(), targetId: args.targetId, revision: 1, createdAt: Date.now(), phase: "failed", verificationUrl: null, userCode: null, error: "BACKUP_REGISTRATION_RECOVERY: Browser fixture; native authorization is not available" };
      state.sessions = [session]; result = session; break;
    }
    case "backup_feishu_authorization_cancel": state.sessions = state.sessions.map(s => s.id === args.sessionId ? { ...s, phase: "cancelled", revision: s.revision + 1 } : s); break;
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
