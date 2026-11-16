import { afterEach, expect, it } from "vitest";
import { backupRestoreStub, rememberBackupPreview } from "./backupRestoreStub";
import { saveStubVault } from "./commands/vault";

afterEach(() => localStorage.clear());

it("keeps failed verification unstaged and never persists the submitted password", () => {
  saveStubVault({ state: "unlocked", masterPassword: "current", entries: [] });
  localStorage.setItem("taomni.stub.mfa.v1", JSON.stringify({ accounts: [{ id: "account" }] }));
  rememberBackupPreview("/preview/manual.taobak", { scope: "core", customOptions: null }, false);
  expect(backupRestoreStub("backup_inspect", { path: "/preview/manual.taobak" })).toMatchObject({
    files: [{ path: "databases/vault.db" }, { path: "databases/mfa.db" }],
  });
  for (const password of [undefined, "wrong"]) {
    expect(() => backupRestoreStub("backup_stage_restore", { path: "/preview/manual.taobak", vaultPassword: password })).toThrow();
    expect(localStorage.getItem("taomni.stub.backup.staged.v1")).toBeNull();
  }
  expect(backupRestoreStub("backup_stage_restore", { path: "/preview/manual.taobak", vaultPassword: "current" })).toMatchObject({ restartRequired: true });
  expect(localStorage.getItem("taomni.stub.backup.staged.v1")).not.toContain("current");
  expect(() => backupRestoreStub("backup_stage_restore", { path: "/missing", vaultPassword: "current" })).toThrow("unavailable");
});

it("keeps archive metadata fixed to the backup range and does not invent native encrypted verification", () => {
  rememberBackupPreview("/preview/custom.taobak", { scope: "custom", customOptions: { includeVault: false, includeMfa: false } }, false);
  saveStubVault({ state: "unlocked", masterPassword: "later", entries: [] });
  localStorage.setItem("taomni.stub.mfa.v1", JSON.stringify({ accounts: [{ id: "added-later" }] }));
  expect(backupRestoreStub("backup_inspect", { path: "/preview/custom.taobak" })).toMatchObject({ files: [] });
  rememberBackupPreview("/preview/encrypted.taobak", { scope: "core", customOptions: null }, true);
  expect(() => backupRestoreStub("backup_inspect", { path: "/preview/encrypted.taobak", password: "anything" })).toThrow("requires native");
});
