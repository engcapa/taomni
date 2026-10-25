import { newFeishuTarget, type AuthorizationSession, type BackupJob, type RemoteBackup } from "../lib/remoteBackup";
import type { BackupSettingsSnapshot, ControlPatch, SettingsEdit } from "../lib/backupSettings";
import { useBackupSettingsStore } from "../stores/backupSettingsStore";
import { useBackupControlStore } from "../stores/backupControlStore";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
export function backupSnapshot(): BackupSettingsSnapshot {
  return { policy: { autoBackupEnabled: false, frequency: "weekly", maxRetainedCopies: 7, defaultScope: "core", includeMail: null, customBackupDir: null, lastBackupAt: null, localChannelEnabled: true },
    remote: { config: { formatVersion: 1, device: { id: "device", name: "Laptop" }, connections: [], targets: [{ ...newFeishuTarget(), id: "target", name: "My Feishu" }], selectedTargetIds: ["local"] }, statuses: [{ targetId: "target", connected: false, passwordConfigured: true }] },
    revisions: { policy: 0, control: 0 } };
}
export function backupHarness() {
  const h = {
    disk: backupSnapshot(), sessions: [] as AuthorizationSession[], jobs: [] as BackupJob[], files: [] as RemoteBackup[],
    history: [{ fileName: "legacy.taobak", filePath: "/backups/legacy.taobak", sizeBytes: 2097152, modifiedAt: 1788500000000, isEncrypted: false }],
    invoke: async (cmd: string, args: Record<string, any> = {}): Promise<any> => {
      if (cmd === "backup_settings_get") return copy(h.disk);
      if (cmd === "backup_settings_patch") {
        const request = args.request as SettingsEdit & { expectedRevision: number };
        if (h.disk.revisions[request.domain] !== request.expectedRevision) throw new Error("BACKUP_CONFIG_CONFLICT");
        if (request.domain === "policy") Object.assign(h.disk.policy, request.patch);
        else {
          const config = h.disk.remote.config, p: ControlPatch = request.patch;
          if (p.op === "addTarget") config.targets.push(p.target);
          if (p.op === "updateTarget") config.targets = config.targets.map((t) => t.id === p.targetId ? { ...t, ...p.fields } : t);
          if (p.op === "removeTarget") { config.targets = config.targets.filter((t) => t.id !== p.targetId); config.selectedTargetIds = config.selectedTargetIds.filter((id) => id !== p.targetId); }
          if (p.op === "setSelectedTargets") config.selectedTargetIds = p.ids;
          if (p.op === "setDeviceName") config.device.name = p.name;
        }
        h.disk.revisions[request.domain]++;
        return copy(h.disk);
      }
      if (cmd === "backup_target_set_password") {
        h.disk.remote.statuses = h.disk.remote.statuses.map((s) => s.targetId === args.targetId ? { ...s, passwordConfigured: true } : s);
        return copy(h.disk);
      }
      if (cmd === "backup_remote_jobs") return copy(h.jobs);
      if (cmd === "backup_feishu_authorization_status") return copy(h.sessions);
      if (cmd === "backup_feishu_apps") return [];
      if (cmd === "backup_remote_list") return copy(h.files);
      if (cmd === "backup_feishu_authorization_cancel") {
        h.sessions = h.sessions.map((s) => s.id === args.sessionId ? { ...s, cancelRequested: true, revision: s.revision + 1 } : s); return;
      }
      if (cmd === "backup_feishu_authorization_forget") {
        h.sessions = h.sessions.map((s) => s.id === args.sessionId ? { ...s, dismissedAt: Date.now(), revision: s.revision + 1 } : s);
        return copy(h.sessions.find((s) => s.id === args.sessionId));
      }
      if (cmd === "backup_feishu_authorize") {
        const session: AuthorizationSession = { id: crypto.randomUUID(), targetId: args.targetId, revision: 1, createdAt: Date.now(), phase: "discovering", cleanupComplete: false, verificationUrl: null, userCode: null, error: null };
        h.sessions.push(session); return copy(session);
      }
      if (cmd === "backup_remote_history_url") { h.disk.remote.config.targets[0].writesPaused = true; return "https://my.feishu.cn/file/file_fixture"; }
      if (cmd === "backup_remote_download") return "download-job";
      if (cmd === "backup_list_history") return copy(h.history);
      if (cmd === "backup_get_default_dir") return "/backups";
      if (cmd === "backup_run_manual") return [{ targetId: "local", jobId: null, localPath: "/backups/manual.taobak", error: null }];
      if (cmd === "backup_delete_item") { h.history = []; return; }
      if (cmd === "backup_inspect") return { formatVersion: 1, appName: "Taomni", appVersion: "0.3.0", createdAt: 1788500000000, backupScope: "core", encrypted: false, files: [] };
      if (cmd === "backup_stage_restore") return { restartRequired: true, manifest: {}, message: "Stage complete" };
      return null;
    },
    reset: () => {
      useBackupSettingsStore.setState({ saved: copy(h.disk), draft: copy(h.disk), pending: [], status: "saved", error: null });
      useBackupControlStore.setState({ sessions: copy(h.sessions), jobs: copy(h.jobs), error: null });
    },
  };
  h.reset();
  return h;
}
