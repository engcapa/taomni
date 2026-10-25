import { invoke } from "@tauri-apps/api/core";
import type { BackupCustomOptions, BackupPolicy, BackupScope, BackupRange } from "./backup";
import type { BackupTarget, RemoteConfiguration } from "./remoteBackup";

export type { BackupRange } from "./backup";
export interface BackupSettingsSnapshot {
  policy: BackupPolicy;
  remote: RemoteConfiguration;
  revisions: { policy: number; control: number };
}
export type ControlPatch =
  | { op: "setDeviceName"; name: string }
  | { op: "setSelectedTargets"; ids: string[] }
  | { op: "addTarget"; target: BackupTarget }
  | { op: "updateTarget"; targetId: string; fields: Partial<BackupTarget> }
  | { op: "removeTarget"; targetId: string };
export type SettingsEdit = { domain: "policy"; patch: Partial<BackupPolicy> } | { domain: "control"; patch: ControlPatch };
export type ManualDestination = { kind: "selected"; localPassword?: string } | { kind: "file"; path: string; password?: string };
export interface DestinationResult { targetId: string; jobId: string | null; localPath: string | null; error: string | null }

export const backupSettings = {
  get: () => invoke<BackupSettingsSnapshot>("backup_settings_get"),
  patch: (edit: SettingsEdit, expectedRevision: number) => invoke<BackupSettingsSnapshot>("backup_settings_patch", {
    request: { ...edit, expectedRevision },
  }),
  password: (targetId: string, password: string) => invoke<BackupSettingsSnapshot>("backup_target_set_password", { targetId, password }),
  manual: (destination: ManualDestination, snapshot: BackupSettingsSnapshot) => invoke<DestinationResult[]>("backup_run_manual", {
    request: { destination, expectedPolicyRevision: snapshot.revisions.policy, expectedControlRevision: snapshot.revisions.control },
  }),
};

export function globalRange(policy: BackupPolicy): BackupRange {
  return { scope: policy.defaultScope as BackupScope, customOptions: policy.defaultScope === "custom"
    ? policy.defaultCustomOptions ?? null : policy.includeMail == null ? null : { includeMail: policy.includeMail } };
}

export function rangeOptions(range: BackupRange): Required<BackupCustomOptions> {
  const core = { includeSessions: true, includeNotes: true, includeVault: true, includeConfigs: true,
    includeMfa: true, includeLanchat: false, includeMail: false, includeLocalHistory: false };
  const options = range.scope === "custom" && range.customOptions
    ? { ...Object.fromEntries(Object.keys(core).map((k) => [k, false])), ...range.customOptions } as typeof core
    : { ...core, includeLanchat: range.scope === "full", includeMail: range.customOptions?.includeMail ?? range.scope === "full" };
  if (options.includeMfa) options.includeVault = true;
  return options;
}

export function preset(scope: BackupScope, current: BackupRange): BackupRange {
  return { scope, customOptions: scope === "custom" ? rangeOptions(current) : { includeMail: scope === "full" } };
}
