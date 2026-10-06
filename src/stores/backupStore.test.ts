import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBackupStore } from "./backupStore";
import type { BackupPolicy, BackupEntryInfo, BackupResult } from "../lib/backup";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("useBackupStore", () => {
  const fakePolicy: BackupPolicy = {
    autoBackupEnabled: false,
    frequency: "weekly",
    customBackupDir: null,
    maxRetainedCopies: 7,
    defaultScope: "core",
    lastBackupAt: null,
  };

  const fakeDefaultDir = "C:\\Users\\test\\AppData\\Roaming\\com.taomni.app\\backups";

  const fakeHistory: BackupEntryInfo[] = [
    {
      fileName: "taomni_backup_20260904_120000.taobak",
      filePath: "C:\\Users\\test\\AppData\\Roaming\\com.taomni.app\\backups\\taomni_backup_20260904_120000.taobak",
      sizeBytes: 1048576,
      modifiedAt: 1788500000000,
      isEncrypted: false,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    useBackupStore.setState({
      policy: null,
      defaultBackupDir: "",
      history: [],
      loading: false,
      creating: false,
      restoring: false,
      lastResult: null,
      error: null,
    });
  });

  it("loads policy, default directory and history on loadAll", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "backup_get_policy") return Promise.resolve(fakePolicy);
      if (cmd === "backup_get_default_dir") return Promise.resolve(fakeDefaultDir);
      if (cmd === "backup_list_history") return Promise.resolve(fakeHistory);
      return Promise.reject(new Error(`unhandled cmd: ${cmd}`));
    });

    await useBackupStore.getState().loadAll();

    const state = useBackupStore.getState();
    expect(state.policy).toEqual(fakePolicy);
    expect(state.defaultBackupDir).toBe(fakeDefaultDir);
    expect(state.history).toEqual(fakeHistory);
    expect(state.error).toBeNull();
  });

  it("updates policy via updatePolicy", async () => {
    useBackupStore.setState({ policy: fakePolicy });

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "backup_get_policy") {
        return Promise.resolve({ ...fakePolicy, customBackupDir: "D:\\MyBackups", autoBackupEnabled: true });
      }
      return Promise.resolve();
    });

    await useBackupStore.getState().updatePolicy({
      customBackupDir: "D:\\MyBackups",
      autoBackupEnabled: true,
    });

    expect(invokeMock).toHaveBeenCalledWith("backup_set_policy", {
      policy: {
        ...fakePolicy,
        customBackupDir: "D:\\MyBackups",
        autoBackupEnabled: true,
      },
    });

    expect(useBackupStore.getState().policy?.customBackupDir).toBe("D:\\MyBackups");
    expect(useBackupStore.getState().policy?.autoBackupEnabled).toBe(true);
  });

  it("triggers backup creation via triggerBackup", async () => {
    useBackupStore.setState({ policy: fakePolicy });

    const fakeResult: BackupResult = {
      filePath: "C:\\test\\taomni_backup.taobak",
      fileName: "taomni_backup.taobak",
      sizeBytes: 2048,
      createdAt: 1788501000000,
      scope: "core",
      encrypted: false,
      filesCount: 3,
    };

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "backup_create") return Promise.resolve(fakeResult);
      if (cmd === "backup_get_policy") return Promise.resolve(fakePolicy);
      if (cmd === "backup_get_default_dir") return Promise.resolve(fakeDefaultDir);
      if (cmd === "backup_list_history") return Promise.resolve(fakeHistory);
      return Promise.resolve(null);
    });

    const result = await useBackupStore.getState().triggerBackup({
      scope: "core",
      targetPath: "C:\\test\\taomni_backup.taobak",
    });

    expect(result).toEqual(fakeResult);
    expect(useBackupStore.getState().lastResult).toEqual(fakeResult);
    expect(useBackupStore.getState().creating).toBe(false);
  });

  it("refreshes both history and the last successful background backup time", async () => {
    useBackupStore.setState({ policy: fakePolicy, history: [] });
    const policy = { ...fakePolicy, autoBackupEnabled: true, lastBackupAt: 1788501000000 };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "backup_get_policy") return Promise.resolve(policy);
      if (cmd === "backup_list_history") return Promise.resolve(fakeHistory);
      return Promise.reject(new Error(`unhandled cmd: ${cmd}`));
    });

    await useBackupStore.getState().refreshHistory();

    expect(useBackupStore.getState().history).toEqual(fakeHistory);
    expect(useBackupStore.getState().policy?.lastBackupAt).toBe(policy.lastBackupAt);
  });

  it("keeps a completed background backup when an older initial history load finishes later", async () => {
    let resolveInitialHistory!: (history: BackupEntryInfo[]) => void;
    const initialHistory = new Promise<BackupEntryInfo[]>((resolve) => { resolveInitialHistory = resolve; });
    let historyReads = 0;
    const policy = { ...fakePolicy, lastBackupAt: 1788501000000 };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "backup_get_default_dir") return Promise.resolve(fakeDefaultDir);
      if (cmd === "backup_list_history") {
        historyReads += 1;
        return historyReads === 1 ? initialHistory : Promise.resolve(fakeHistory);
      }
      if (cmd === "backup_get_policy") return Promise.resolve(historyReads <= 1 ? fakePolicy : policy);
      return Promise.reject(new Error(`unhandled cmd: ${cmd}`));
    });

    const initialLoad = useBackupStore.getState().loadAll();
    await useBackupStore.getState().refreshHistory();
    resolveInitialHistory([]);
    await initialLoad;

    expect(useBackupStore.getState().history).toEqual(fakeHistory);
    expect(useBackupStore.getState().policy?.lastBackupAt).toBe(policy.lastBackupAt);
    expect(useBackupStore.getState().defaultBackupDir).toBe(fakeDefaultDir);
    expect(useBackupStore.getState().loading).toBe(false);
  });

  it("keeps a newer backend backup timestamp when changing a stale policy", async () => {
    useBackupStore.setState({ policy: fakePolicy });
    const policy = { ...fakePolicy, frequency: "daily" as const, lastBackupAt: 1788501000000 };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "backup_get_policy") return Promise.resolve(policy);
      return Promise.resolve();
    });

    await useBackupStore.getState().updatePolicy({ frequency: "daily" });

    expect(useBackupStore.getState().policy).toEqual(policy);
  });

  it("saves rapid policy edits in order without losing other changed fields", async () => {
    useBackupStore.setState({ policy: fakePolicy });
    let saved = { ...fakePolicy };
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let writes = 0;
    invokeMock.mockImplementation(async (cmd: string, args?: { policy: BackupPolicy }) => {
      if (cmd === "backup_get_policy") return { ...saved };
      if (cmd === "backup_set_policy") {
        writes += 1;
        if (writes === 1) await firstWrite;
        saved = { ...args!.policy };
        return;
      }
      throw new Error(`unhandled cmd: ${cmd}`);
    });

    const first = useBackupStore.getState().updatePolicy({ frequency: "daily" });
    const second = useBackupStore.getState().updatePolicy({ maxRetainedCopies: 2 });
    await vi.waitFor(() => expect(writes).toBeGreaterThan(0));
    releaseFirst();
    await Promise.all([first, second]);

    expect(saved).toMatchObject({ frequency: "daily", maxRetainedCopies: 2 });
    expect(useBackupStore.getState().policy).toEqual(saved);
  });

  it("keeps a saved policy when an older history read finishes after the edit", async () => {
    useBackupStore.setState({ policy: fakePolicy });
    let saved = { ...fakePolicy };
    let finishRead!: (policy: BackupPolicy) => void;
    const staleRead = new Promise<BackupPolicy>((resolve) => { finishRead = resolve; });
    let reads = 0;
    invokeMock.mockImplementation(async (cmd: string, args?: { policy: BackupPolicy }) => {
      if (cmd === "backup_list_history") return fakeHistory;
      if (cmd === "backup_get_policy") return ++reads === 1 ? staleRead : { ...saved };
      if (cmd === "backup_set_policy") { saved = { ...args!.policy }; return; }
      throw new Error(`unhandled cmd: ${cmd}`);
    });
    const refresh = useBackupStore.getState().refreshHistory();
    await useBackupStore.getState().updatePolicy({ frequency: "daily" });
    finishRead(fakePolicy);
    await refresh;

    expect(useBackupStore.getState().policy?.frequency).toBe("daily");
    expect(useBackupStore.getState().history).toEqual(fakeHistory);
  });

  it("deletes a backup file via deleteBackup", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "backup_delete_item") return Promise.resolve();
      if (cmd === "backup_list_history") return Promise.resolve([]);
      return Promise.resolve(null);
    });

    await useBackupStore.getState().deleteBackup("test.taobak");

    expect(invokeMock).toHaveBeenCalledWith("backup_delete_item", {
      fileName: "test.taobak",
    });
    expect(useBackupStore.getState().history).toEqual([]);
  });

  it("performs stage restore with vaultPassword", async () => {
    const fakeStageResult = {
      manifest: {
        formatVersion: 1,
        appName: "Taomni",
        appVersion: "0.3.0",
        createdAt: 1788500000000,
        backupScope: "core",
        encrypted: false,
        files: [],
      },
      restartRequired: true,
      message: "Stage complete",
    };

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "backup_stage_restore") return Promise.resolve(fakeStageResult);
      return Promise.resolve(null);
    });

    const res = await useBackupStore
      .getState()
      .performStageRestore("test.taobak", "encPassword", "vaultPassword123");

    expect(invokeMock).toHaveBeenCalledWith("backup_stage_restore", {
      path: "test.taobak",
      password: "encPassword",
      vaultPassword: "vaultPassword123",
    });
    expect(res).toEqual(fakeStageResult);
    expect(useBackupStore.getState().restoring).toBe(false);
  });
});
