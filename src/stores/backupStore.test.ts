import { beforeEach, expect, it, vi } from "vitest";
import { useBackupStore as store } from "./backupStore";
import { useBackupSettingsStore } from "./backupSettingsStore";
import { backupHarness, deferred } from "../test/backupHarness";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let h: ReturnType<typeof backupHarness>;
beforeEach(() => {
  vi.clearAllMocks(); h = backupHarness(); invoke.mockImplementation(h.invoke);
  store.setState({ history: [], defaultBackupDir: "", creating: false, restoring: false, loading: false, error: null });
});
it("loads the shared policy, directory and local history", async () => {
  await store.getState().loadAll();
  expect(store.getState()).toMatchObject({ policy: h.disk.policy, defaultBackupDir: "/backups", history: h.history, loading: false, error: null });
});
it("delegates policy changes to the revisioned settings owner", async () => {
  h.disk.policy.lastBackupAt = 500;
  await store.getState().updatePolicy({ frequency: "daily" });
  expect(invoke).toHaveBeenCalledWith("backup_settings_patch", expect.objectContaining({ request: expect.objectContaining({ patch: { frequency: "daily" } }) }));
  expect(store.getState().policy).toMatchObject({ frequency: "daily", lastBackupAt: 500 });
});
it("keeps the latest history when an older initial load finishes late", async () => {
  const held = deferred<typeof h.history>(); let reads = 0;
  invoke.mockImplementation((cmd, args) => cmd === "backup_list_history" && ++reads === 1 ? held.promise : h.invoke(cmd, args));
  const initial = store.getState().loadAll();
  h.disk.policy.lastBackupAt = 1000;
  await store.getState().refreshHistory(); held.resolve([]); await initial;
  expect(store.getState().history).toEqual(h.history);
  expect(store.getState().policy?.lastBackupAt).toBe(1000);
});
it("retains failed policy drafts in the compatibility facade", async () => {
  invoke.mockRejectedValueOnce(new Error("disk failed"));
  await expect(store.getState().updatePolicy({ frequency: "daily" })).rejects.toThrow("disk failed");
  expect(store.getState().policy?.frequency).toBe("daily");
  await useBackupSettingsStore.getState().retry();
  expect(h.disk.policy.frequency).toBe("daily");
});
it("uses the saved global range for legacy manual callers", async () => {
  h.disk.policy.defaultScope = "full"; h.disk.policy.includeMail = false; h.reset();
  const result = { filePath: "/backups/new.taobak", fileName: "new.taobak", scope: "full", encrypted: false, sizeBytes: 4, filesCount: 1, createdAt: 2 };
  invoke.mockImplementation((cmd, args) => cmd === "backup_create" ? Promise.resolve(result) : h.invoke(cmd, args));
  expect(await store.getState().triggerBackup({ scope: "core", targetPath: "/backups/new.taobak" })).toEqual(result);
  expect(invoke).toHaveBeenCalledWith("backup_create", expect.objectContaining({ scope: "full", customOptions: { includeMail: false } }));
  expect(store.getState().creating).toBe(false);
});
it("refreshes history after deletion and passes archive and vault passwords to restore", async () => {
  await store.getState().deleteBackup("legacy.taobak");
  expect(invoke).toHaveBeenCalledWith("backup_delete_item", { fileName: "legacy.taobak" });
  expect(store.getState().history).toEqual([]);
  await store.getState().performStageRestore("legacy.taobak", "archive", "vault");
  expect(invoke).toHaveBeenCalledWith("backup_stage_restore", { path: "legacy.taobak", password: "archive", vaultPassword: "vault" });
  expect(store.getState().restoring).toBe(false);
});
it("surfaces restore failures and releases its busy state", async () => {
  invoke.mockRejectedValueOnce(new Error("BACKUP_BAD_PASSWORD"));
  await expect(store.getState().performStageRestore("legacy.taobak", "wrong")).rejects.toThrow("BACKUP_BAD_PASSWORD");
  expect(store.getState()).toMatchObject({ restoring: false, error: "BACKUP_BAD_PASSWORD" });
});
