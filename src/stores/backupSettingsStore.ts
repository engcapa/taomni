import { create } from "zustand";
import { backupSettings, type BackupSettingsSnapshot, type ControlPatch, type SettingsEdit, type ManualDestination } from "../lib/backupSettings";
import type { BackupPolicy } from "../lib/backup";

function apply(snapshot: BackupSettingsSnapshot, edit: SettingsEdit): BackupSettingsSnapshot {
  if (edit.domain === "policy") return { ...snapshot, policy: { ...snapshot.policy, ...edit.patch } };
  const config = snapshot.remote.config;
  const patch = edit.patch;
  let next = config;
  switch (patch.op) {
    case "setDeviceName": next = { ...config, device: { ...config.device, name: patch.name } }; break;
    case "setSelectedTargets": next = { ...config, selectedTargetIds: patch.ids }; break;
    case "addTarget": next = { ...config, targets: [...config.targets, patch.target] }; break;
    case "updateTarget": next = { ...config, targets: config.targets.map((t) => t.id === patch.targetId ? { ...t, ...patch.fields } : t) }; break;
    case "removeTarget": next = { ...config, targets: config.targets.filter((t) => t.id !== patch.targetId), selectedTargetIds: config.selectedTargetIds.filter((id) => id !== patch.targetId) }; break;
  }
  return { ...snapshot, remote: { ...snapshot.remote, config: next } };
}

interface SettingsState {
  saved: BackupSettingsSnapshot | null;
  draft: BackupSettingsSnapshot | null;
  pending: SettingsEdit[];
  status: "loading" | "saved" | "saving" | "error";
  error: string | null;
  refresh: () => Promise<void>;
  editPolicy: (patch: Partial<BackupPolicy>) => void;
  editControl: (patch: ControlPatch) => void;
  retry: () => Promise<void>;
  flush: () => Promise<BackupSettingsSnapshot>;
  setPassword: (targetId: string, password: string) => Promise<void>;
  runManual: (destination: ManualDestination) => ReturnType<typeof backupSettings.manual>;
}

let worker: Promise<void> | null = null;
let generation = 0;
let readId = 0;
const message = (e: unknown) => e instanceof Error ? e.message : String(e);

export const useBackupSettingsStore = create<SettingsState>((set, get) => {
  const redraft = (saved: BackupSettingsSnapshot, pending = get().pending) => pending.reduce(apply, saved);
  const drain = (): Promise<void> => {
    if (worker) return worker;
    worker = (async () => {
      set({ status: "saving", error: null });
      while (get().pending.length) {
        const { saved, pending } = get();
        if (!saved) throw new Error("BACKUP_CONFIG_NOT_LOADED");
        const edit = pending[0];
        try {
          const value = await backupSettings.patch(edit, saved.revisions[edit.domain]);
          const remaining = get().pending.slice(1);
          set({ saved: value, pending: remaining, draft: redraft(value, remaining) });
        } catch (e) {
          if (message(e).includes("BACKUP_CONFIG_CONFLICT")) {
            const latest = await backupSettings.get().catch(() => null);
            if (latest) set({ saved: latest, draft: redraft(latest) });
          }
          throw e;
        }
      }
      set({ status: "saved", error: null });
    })().catch((e) => { set({ status: "error", error: message(e) }); }).finally(() => { worker = null; });
    return worker;
  };
  const edit = (value: SettingsEdit) => {
    if (!get().draft) return;
    generation++;
    set({ pending: [...get().pending, value], draft: apply(get().draft!, value) });
    if (get().status !== "error") void drain();
  };
  return {
    saved: null, draft: null, pending: [], status: "loading", error: null,
    refresh: async () => {
      const id = ++readId, version = generation;
      try {
        const value = await backupSettings.get();
        if (id === readId && version === generation && !get().pending.length && !worker) {
          set({ saved: value, draft: value, status: "saved", error: null });
        }
      } catch (e) { if (id === readId) set({ error: message(e), status: "error" }); }
    },
    editPolicy: (patch) => edit({ domain: "policy", patch }),
    editControl: (patch) => edit({ domain: "control", patch }),
    retry: async () => { if (!get().saved) await get().refresh(); else await drain(); },
    flush: async () => {
      if (worker) await worker;
      if (get().pending.length || get().status === "error" || !get().saved) throw new Error(get().error || "BACKUP_CONFIG_NOT_LOADED");
      return get().saved!;
    },
    setPassword: async (targetId, password) => {
      await get().flush();
      const version = ++generation;
      const value = await backupSettings.password(targetId, password);
      // Passwords never enter the settings snapshot, draft, or local storage.
      if (version === generation) set({ saved: value, draft: redraft(value) });
    },
    runManual: async (destination) => backupSettings.manual(destination, await get().flush()),
  };
});

/** Keep acknowledged Backup edits durable before the application exits. */
export async function saveBackupSettingsBeforeExit(confirmRetry: () => Promise<boolean>): Promise<boolean> {
  while (useBackupSettingsStore.getState().pending.length) {
    try {
      await useBackupSettingsStore.getState().flush();
    } catch {
      if (!await confirmRetry()) return false;
      await useBackupSettingsStore.getState().retry();
    }
  }
  return true;
}
