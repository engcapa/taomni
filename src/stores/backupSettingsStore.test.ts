import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveBackupSettingsBeforeExit, useBackupSettingsStore as store } from "./backupSettingsStore";
import { backupHarness, copy, deferred } from "../test/backupHarness";
import { globalRange, rangeOptions, preset, type BackupSettingsSnapshot } from "../lib/backupSettings";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let h: ReturnType<typeof backupHarness>;
beforeEach(() => { vi.clearAllMocks(); h = backupHarness(); invoke.mockImplementation(h.invoke); });

describe("persisted backup settings", () => {
  it("saves full plus mail atomically, retains explicit exclusion and survives a fresh read", async () => {
    store.getState().editPolicy({ defaultScope: "full", includeMail: true });
    await store.getState().flush();
    expect(invoke).toHaveBeenCalledWith("backup_settings_patch", { request: { domain: "policy", expectedRevision: 0, patch: { defaultScope: "full", includeMail: true } } });
    store.getState().editPolicy({ includeMail: false }); await store.getState().flush();
    store.setState({ draft: null }); await store.getState().refresh();
    expect(store.getState().draft?.policy).toMatchObject({ defaultScope: "full", includeMail: false });
  });
  it("serializes edits without flicker and ignores an earlier snapshot completing late", async () => {
    const held = deferred<unknown>(), read = deferred<BackupSettingsSnapshot>();
    const stale = copy(h.disk);
    let writes = 0;
    invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "backup_settings_get") return read.promise;
      if (cmd === "backup_settings_patch" && ++writes === 1) await held.promise;
      return h.invoke(cmd, args);
    });
    const refresh = store.getState().refresh();
    store.getState().editPolicy({ frequency: "daily" });
    store.getState().editPolicy({ frequency: "on_exit", includeMail: true });
    expect(store.getState().draft?.policy).toMatchObject({ frequency: "on_exit", includeMail: true });
    held.resolve(null); await store.getState().flush(); read.resolve(stale); await refresh;
    expect(h.disk.policy).toMatchObject({ frequency: "on_exit", includeMail: true });
    expect(store.getState().draft?.policy.frequency).toBe("on_exit");
  });
  it("retains a failed draft, blocks execution and retries all queued edits", async () => {
    invoke.mockRejectedValueOnce(new Error("disk unavailable"));
    store.getState().editPolicy({ defaultScope: "full", includeMail: true });
    await expect(store.getState().flush()).rejects.toThrow("disk unavailable");
    store.getState().editPolicy({ frequency: "daily" });
    await store.getState().refresh();
    expect(store.getState().draft?.policy).toMatchObject({ defaultScope: "full", frequency: "daily" });
    await expect(store.getState().runManual({ kind: "selected" })).rejects.toThrow();
    expect(invoke.mock.calls.some(([cmd]) => cmd === "backup_run_manual")).toBe(false);
    await store.getState().retry(); await store.getState().flush();
    expect(h.disk.policy).toMatchObject({ defaultScope: "full", frequency: "daily", includeMail: true });
  });
  it("rebases a conflict against current metadata while preserving the draft", async () => {
    h.disk.revisions.policy = 4; h.disk.policy.lastBackupAt = 500;
    store.getState().editPolicy({ defaultScope: "full", includeMail: true });
    await expect(store.getState().flush()).rejects.toThrow("BACKUP_CONFIG_CONFLICT");
    expect(store.getState().draft?.policy).toMatchObject({ defaultScope: "full", lastBackupAt: 500 });
    await store.getState().retry();
    expect(h.disk.revisions.policy).toBe(5); expect(h.disk.policy.lastBackupAt).toBe(500);
  });
  it("flushes pending settings before manual execution and sends revision guards", async () => {
    const held = deferred<unknown>();
    invoke.mockImplementation(async (cmd, args) => { if (cmd === "backup_settings_patch") await held.promise; return h.invoke(cmd, args); });
    store.getState().editPolicy({ defaultScope: "full", includeMail: true });
    const run = store.getState().runManual({ kind: "selected" });
    expect(invoke.mock.calls.some(([cmd]) => cmd === "backup_run_manual")).toBe(false);
    held.resolve(null); await run;
    expect(invoke).toHaveBeenCalledWith("backup_run_manual", { request: { destination: { kind: "selected" }, expectedPolicyRevision: 1, expectedControlRevision: 0 } });
  });
  it("stores only keyring status and never copies the cloud password into settings", async () => {
    await store.getState().setPassword("target", "private-password");
    expect(JSON.stringify(store.getState().draft)).not.toContain("private-password");
    expect(invoke).toHaveBeenCalledWith("backup_target_set_password", { targetId: "target", password: "private-password" });
  });
  it("preserves the scope contract and makes presets atomic", () => {
    const full = preset("full", globalRange(h.disk.policy));
    expect(rangeOptions(full)).toMatchObject({ includeMail: true, includeLanchat: true, includeLocalHistory: false });
    expect(rangeOptions({ ...full, customOptions: { includeMail: false } }).includeMail).toBe(false);
    expect(rangeOptions({ scope: "custom", customOptions: { includeMfa: true } })).toMatchObject({ includeMfa: true, includeVault: true, includeSessions: false });
    expect(preset("core", full).customOptions?.includeMail).toBe(false);
  });
});

it("removes only the selected destination and its manual selection", async () => {
  h.disk.remote.config.selectedTargetIds = ["local", "target"]; h.reset();
  store.getState().editControl({ op: "removeTarget", targetId: "target" });
  await store.getState().flush();
  expect(h.disk.remote.config.targets).toEqual([]);
  expect(h.disk.remote.config.selectedTargetIds).toEqual(["local"]);
});

it("waits for queued backup settings before allowing exit", async () => {
  const held = deferred<unknown>();
  invoke.mockImplementation(async (cmd, args) => {
    if (cmd === "backup_settings_patch") await held.promise;
    return h.invoke(cmd, args);
  });
  store.getState().editPolicy({ defaultScope: "full", includeMail: true });
  const confirmRetry = vi.fn();
  const exiting = saveBackupSettingsBeforeExit(confirmRetry);
  expect(h.disk.policy.defaultScope).toBe("core");
  held.resolve(null);
  await expect(exiting).resolves.toBe(true);
  expect(h.disk.policy.defaultScope).toBe("full");
  expect(confirmRetry).not.toHaveBeenCalled();
});

it("allows cancelling exit after a save failure and retries the retained draft", async () => {
  invoke.mockRejectedValueOnce(new Error("disk unavailable"));
  store.getState().editPolicy({ defaultScope: "full", includeMail: true });
  await expect(saveBackupSettingsBeforeExit(async () => false)).resolves.toBe(false);
  expect(h.disk.policy.defaultScope).toBe("core");
  expect(store.getState().draft?.policy.defaultScope).toBe("full");
  await expect(saveBackupSettingsBeforeExit(async () => true)).resolves.toBe(true);
  expect(h.disk.policy.defaultScope).toBe("full");
});
