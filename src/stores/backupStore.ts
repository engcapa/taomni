import { create } from "zustand";
import {
  createBackup,
  deleteBackupItem,
  getBackupPolicy,
  getDefaultBackupDir,
  inspectBackup,
  listBackupHistory,
  setBackupPolicy,
  stageRestore,
  type BackupCustomOptions,
  type BackupEntryInfo,
  type BackupManifest,
  type BackupPolicy,
  type BackupResult,
  type BackupScope,
  type StageRestoreResult,
} from "../lib/backup";

interface BackupStore {
  policy: BackupPolicy | null;
  defaultBackupDir: string;
  history: BackupEntryInfo[];
  loading: boolean;
  creating: boolean;
  restoring: boolean;
  lastResult: BackupResult | null;
  error: string | null;

  loadAll: () => Promise<void>;
  refreshHistory: () => Promise<void>;
  updatePolicy: (patch: Partial<BackupPolicy>) => Promise<void>;
  triggerBackup: (params: {
    scope?: BackupScope;
    customOptions?: BackupCustomOptions;
    targetPath?: string;
    password?: string;
  }) => Promise<BackupResult>;
  inspectArchive: (path: string, password?: string) => Promise<BackupManifest>;
  performStageRestore: (
    path: string,
    password?: string,
    vaultPassword?: string,
  ) => Promise<StageRestoreResult>;
  deleteBackup: (fileName: string) => Promise<void>;
  clearError: () => void;
}

let latestHistoryRequest = 0;

export const useBackupStore = create<BackupStore>((set, get) => ({
  policy: null,
  defaultBackupDir: "",
  history: [],
  loading: false,
  creating: false,
  restoring: false,
  lastResult: null,
  error: null,

  clearError: () => set({ error: null }),

  loadAll: async () => {
    set({ loading: true, error: null });
    try {
      const [defaultDir] = await Promise.all([
        getDefaultBackupDir(),
        get().refreshHistory(),
      ]);
      set({ defaultBackupDir: defaultDir });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },

  refreshHistory: async () => {
    const request = ++latestHistoryRequest;
    try {
      const [history, policy] = await Promise.all([
        listBackupHistory(),
        getBackupPolicy(),
      ]);
      if (request === latestHistoryRequest) set({ history, policy });
    } catch (e) {
      if (request === latestHistoryRequest) {
        set({ error: e instanceof Error ? e.message : String(e) });
      }
    }
  },

  updatePolicy: async (patch) => {
    const current = get().policy;
    if (!current) return;
    const next: BackupPolicy = { ...current, ...patch };
    try {
      await setBackupPolicy(next);
      // The backend preserves the latest timestamp from automatic backups.
      const policy = await getBackupPolicy();
      set({ policy });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },

  triggerBackup: async (params) => {
    set({ creating: true, error: null });
    try {
      const result = await createBackup(params);
      set({ lastResult: result });
      await get().loadAll();
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ error: msg });
      throw e;
    } finally {
      set({ creating: false });
    }
  },

  inspectArchive: async (path, password) => {
    return inspectBackup(path, password);
  },

  performStageRestore: async (path, password, vaultPassword) => {
    set({ restoring: true, error: null });
    try {
      const res = await stageRestore(path, password, vaultPassword);
      return res;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ error: msg });
      throw e;
    } finally {
      set({ restoring: false });
    }
  },

  deleteBackup: async (fileName) => {
    try {
      await deleteBackupItem(fileName);
      await get().refreshHistory();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },
}));
