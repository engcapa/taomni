import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BackupSettingsPanel } from "./BackupSettingsPanel";
import { useBackupStore } from "../../stores/backupStore";
import { useBackupSettingsStore as settings } from "../../stores/backupSettingsStore";
import { useVaultStore } from "../../stores/vaultStore";
import { backupHarness, deferred } from "../../test/backupHarness";
import { setLocale } from "../../lib/i18n";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), saveFile: vi.fn(), directory: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: mocks.open }));
vi.mock("../../lib/ipc", () => ({ selectFilePath: vi.fn(), selectSaveDirectory: mocks.directory, selectSaveFilePath: mocks.saveFile }));
vi.mock("../../lib/updateService", () => ({ relaunchApp: vi.fn() }));
let h: ReturnType<typeof backupHarness>;
beforeEach(() => {
  vi.clearAllMocks(); setLocale("en"); h = backupHarness();
  mocks.invoke.mockImplementation(h.invoke); mocks.listen.mockResolvedValue(vi.fn());
  useBackupStore.setState({ history: h.history, defaultBackupDir: "/backups", error: null, creating: false, restoring: false });
  useVaultStore.setState({ state: "unlocked", refresh: vi.fn().mockResolvedValue(undefined) });
});
afterEach(() => { cleanup(); vi.useRealTimers(); setLocale("en"); });
it("saves full data with mail, restores it after remount, and removes manual scope inputs", async () => {
  const view = render(<BackupSettingsPanel />);
  fireEvent.click(screen.getByTestId("backup-global-include-mail"));
  expect(screen.getByTestId("backup-global-include-mail")).toBeChecked();
  await settings.getState().flush(); view.unmount();
  settings.setState({ draft: null });
  render(<BackupSettingsPanel />);
  await waitFor(() => expect(screen.getByTestId("backup-global-include-mail")).toBeChecked());
  expect(within(screen.getByTestId("backup-manual")).queryByRole("combobox")).toBeNull();
  fireEvent.click(screen.getByTestId("backup-global-include-mail"));
  fireEvent.click(screen.getByTestId("backup-selected-start"));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("backup_run_manual", expect.objectContaining({ request: expect.objectContaining({ expectedPolicyRevision: 2 }) })));
  expect(h.disk.policy).toMatchObject({ defaultScope: "custom", includeMail: false });
});
it("keeps rapid frequency changes visible while saving", async () => {
  const held = deferred<unknown>(); let writes = 0;
  mocks.invoke.mockImplementation(async (cmd, args) => { if (cmd === "backup_settings_patch" && ++writes === 1) await held.promise; return h.invoke(cmd, args); });
  render(<BackupSettingsPanel />);
  fireEvent.change(screen.getByTestId("backup-auto-frequency"), { target: { value: "daily" } });
  fireEvent.change(screen.getByTestId("backup-auto-frequency"), { target: { value: "on_exit" } });
  expect(screen.getByTestId("backup-auto-frequency")).toHaveValue("on_exit");
  expect(screen.getByTestId("backup-settings-save-status")).toHaveTextContent("Saving");
  await act(async () => { held.resolve(null); await settings.getState().flush(); });
  expect(h.disk.policy.frequency).toBe("on_exit");
});
it("preserves failed drafts visibly, blocks execution and offers retry", async () => {
  mocks.invoke.mockImplementation((cmd, args) => cmd === "backup_settings_patch" ? Promise.reject(new Error("disk failed")) : h.invoke(cmd, args));
  render(<BackupSettingsPanel />);
  fireEvent.click(screen.getByTestId("backup-global-include-mail"));
  await screen.findByTestId("backup-settings-retry");
  expect(screen.getByTestId("backup-global-include-mail")).toBeChecked();
  expect(screen.getByTestId("backup-selected-start")).toBeDisabled();
  mocks.invoke.mockImplementation(h.invoke);
  fireEvent.click(screen.getByTestId("backup-settings-retry"));
  await waitFor(() => expect(screen.getByTestId("backup-settings-save-status")).toHaveTextContent("Saved"));
});
it("switches languages without resetting range or pending edits", async () => {
  render(<BackupSettingsPanel />);
  fireEvent.click(screen.getByTestId("backup-global-include-mail"));
  await act(async () => { await settings.getState().flush(); setLocale("zh-CN"); });
  expect(screen.getByText("全局默认配置")).toBeDefined();
  expect(screen.getByTestId("backup-global-include-mail")).toBeChecked();
  expect(screen.getByTestId("backup-settings-save-status")).toHaveTextContent("已保存");
});
it("uses the global revision for file export and retains local encryption", async () => {
  mocks.saveFile.mockResolvedValue("/exports/full.taobak");
  render(<BackupSettingsPanel />);
  fireEvent.click(screen.getByTestId("backup-local-encryption"));
  fireEvent.change(screen.getByTestId("backup-local-password"), { target: { value: "archive-password" } });
  fireEvent.click(screen.getByTestId("backup-export"));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("backup_run_manual", { request: { destination: { kind: "file", path: "/exports/full.taobak", password: "archive-password" }, expectedPolicyRevision: 0, expectedControlRevision: 0 } }));
});
it("keeps custom directory changes and local history operations", async () => {
  h.disk.policy.customBackupDir = "/custom"; h.reset(); mocks.directory.mockResolvedValue("/new");
  render(<BackupSettingsPanel />);
  expect(screen.getByTestId("backup-effective-directory")).toHaveTextContent("/custom");
  expect(screen.getByText("2.00 MB")).toBeDefined(); expect(screen.getByText("legacy.taobak")).toBeDefined();
  fireEvent.click(screen.getByTestId("backup-change-directory"));
  await waitFor(() => expect(h.disk.policy.customBackupDir).toBe("/new"));
});
it("keeps the opaque restore dialog and requires current vault verification", async () => {
  render(<BackupSettingsPanel />); fireEvent.click(screen.getByTestId("backup-history-restore"));
  const dialog = screen.getByTestId("backup-restore-dialog");
  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(dialog).toHaveProperty("style.background", "var(--taomni-bg)");
  expect(dialog).toHaveProperty("style.borderColor", "var(--taomni-card-border)");
  await screen.findByText("0.3.0");
  fireEvent.click(screen.getByText("Confirm Restore & Restart Now"));
  expect(screen.getByText("Vault master password is required.")).toBeDefined();
  expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "backup_stage_restore")).toBe(false);
});
it("refreshes history and background timestamp on completion", async () => {
  render(<BackupSettingsPanel />);
  await waitFor(() => expect(useBackupStore.getState().loading).toBe(false));
  h.disk.policy.lastBackupAt = 1788501000000; h.history = [{ ...h.history[0], fileName: "auto.taobak" }];
  await act(async () => { await mocks.listen.mock.calls.find(([event]) => event === "backup-completed")![1]({ payload: {} }); });
  await screen.findByText("auto.taobak");
  expect(screen.getByTestId("backup-last-success")).not.toHaveTextContent("Never");
});
it("polls shared disk history and stops all observers when closed", async () => {
  vi.useFakeTimers(); const view = render(<BackupSettingsPanel />); await act(async () => {});
  h.history = [{ ...h.history[0], fileName: "other-instance.taobak" }];
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(screen.getByText("other-instance.taobak")).toBeDefined();
  view.unmount(); mocks.invoke.mockClear(); await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(mocks.invoke).not.toHaveBeenCalled();
});
it("cleans listeners registered after the panel was closed", async () => {
  const held = deferred<() => void>(), stop = vi.fn();
  mocks.listen.mockImplementation((event) => event === "backup-completed" ? held.promise : Promise.resolve(vi.fn()));
  const view = render(<BackupSettingsPanel />); view.unmount();
  await act(async () => held.resolve(stop)); expect(stop).toHaveBeenCalledOnce();
});
