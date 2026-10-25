import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RemoteBackupPanel } from "./RemoteBackupPanel";
import { BackupAuthorizationBanner } from "./backup/BackupAuthorizationBanner";
import { BackupCloudActivity } from "./backup/BackupCloudActivity";
import { useBackupSettingsStore as settings } from "../../stores/backupSettingsStore";
import { observeBackupControl, useBackupControlStore as control } from "../../stores/backupControlStore";
import { backupHarness } from "../../test/backupHarness";
import { setLocale } from "../../lib/i18n";
import type { AuthorizationSession } from "../../lib/remoteBackup";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), open: vi.fn(), events: new Map<string, (event: { payload: any }) => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: mocks.open }));
vi.mock("./AppProxyPanel", () => ({ AppProxyPanel: () => <div>Proxy editor</div> }));
let h: ReturnType<typeof backupHarness>;
const waiting = (): AuthorizationSession => ({ id: crypto.randomUUID(), targetId: "target", createdAt: Date.now(), revision: 2, phase: "awaiting_authorization", cleanupComplete: false, verificationUrl: "https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=fixture", userCode: "CODE", error: null });
function Panel() {
  useEffect(observeBackupControl, []);
  return <><BackupAuthorizationBanner /><RemoteBackupPanel /><BackupCloudActivity onRestore={vi.fn()} /></>;
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.events.clear(); setLocale("en"); h = backupHarness();
  mocks.invoke.mockImplementation(h.invoke); mocks.open.mockResolvedValue(undefined);
  mocks.listen.mockImplementation(async (event, handler) => { mocks.events.set(event, handler); return () => mocks.events.delete(event); });
});
afterEach(() => { cleanup(); setLocale("en"); });
const publish = async (session: AuthorizationSession) => { h.sessions = [session]; await act(async () => mocks.events.get("backup-authorization")!({ payload: session })); };

it("keeps A's cancellation visible while adding B and waits for cleanup before reconnecting (#714)", async () => {
  const session = waiting(); h.sessions = [session]; h.reset(); render(<Panel />);
  await screen.findByText(/Awaiting browser authorization/);
  fireEvent.click(screen.getByTestId("backup-feishu-add")); await settings.getState().flush();
  expect(screen.getAllByTestId("backup-cloud-destination")).toHaveLength(2);
  expect(screen.getByTestId("backup-authorization-cancel")).toBeEnabled();
  fireEvent.click(screen.getByTestId("backup-authorization-cancel"));
  await screen.findByText(/Cancelling/);
  expect(screen.getAllByTestId("backup-feishu-authorize").every((button) => button.hasAttribute("disabled"))).toBe(true);
  expect(screen.queryByTestId("backup-authorization-forget")).toBeNull();
  await publish({ ...session, revision: 4, phase: "cancelled", cancelRequested: true, cleanupComplete: false, verificationUrl: null });
  expect(screen.queryByTestId("backup-authorization-forget")).toBeNull();
  await publish({ ...session, revision: 5, phase: "cancelled", cancelRequested: true, cleanupComplete: true, verificationUrl: null });
  expect(screen.getAllByTestId("backup-feishu-authorize").every((button) => !button.hasAttribute("disabled"))).toBe(true);
  expect(screen.getByTestId("backup-authorization-forget")).toBeEnabled();
});
it("keeps a dismiss tombstone so stale events and snapshots cannot resurrect the banner", async () => {
  const session = { ...waiting(), phase: "cancelled", cleanupComplete: true };
  h.sessions = [session]; h.reset(); render(<Panel />);
  fireEvent.click(await screen.findByTestId("backup-authorization-forget"));
  await waitFor(() => expect(screen.queryByTestId("backup-feishu-session")).toBeNull());
  await publish({ ...session, revision: 1, phase: "awaiting_authorization", cleanupComplete: false });
  await control.getState().refresh();
  expect(screen.queryByTestId("backup-feishu-session")).toBeNull();
});
it("requires acknowledgement for explicit registration restart and retains credentials on normal reconnect", async () => {
  const session = { ...waiting(), phase: "expired", cleanupComplete: true, verificationUrl: null };
  h.sessions = [session]; h.reset(); render(<Panel />);
  const restart = await screen.findByTestId("backup-restart-application"); expect(restart).toBeDisabled();
  fireEvent.click(screen.getByTestId("backup-restart-confirm")); fireEvent.click(restart);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("backup_feishu_authorize", { targetId: "target", applicationSelection: null, restartApplication: true }));
});
it("switches pending authorization, errors and recovery controls live between languages", async () => {
  h.sessions = [{ ...waiting(), error: "Cannot read the system credential store" }]; h.reset(); render(<Panel />);
  await screen.findByText(/Verification code: CODE/);
  expect(screen.getByText("Could not access the system credential store. Unlock it or check system permissions, then retry.")).toBeDefined();
  await act(async () => setLocale("zh-CN"));
  expect(screen.getByText(/等待浏览器授权/)).toBeDefined();
  expect(screen.getByText("无法访问系统凭据库，请解锁或检查系统权限后重试。")).toBeDefined();
  expect(screen.getByTestId("backup-authorization-cancel")).toHaveTextContent("取消连接");
});
it("persists a channel proxy and inherits the global scope without exposing application secrets", async () => {
  render(<Panel />);
  expect(screen.queryByText("App ID")).toBeNull(); expect(screen.queryByText("App Secret")).toBeNull();
  expect(screen.getByTestId("backup-cloud-range-mode")).toHaveValue("inherit");
  fireEvent.change(screen.getByTestId("backup-cloud-proxy"), { target: { value: "none" } });
  await settings.getState().flush();
  expect(h.disk.remote.config.targets[0].proxy.mode).toBe("none");
  expect(mocks.invoke).toHaveBeenCalledWith("backup_settings_patch", expect.objectContaining({ request: expect.objectContaining({ patch: expect.objectContaining({ op: "updateTarget", targetId: "target" }) }) }));
});
it("keeps legacy custom scope until inheritance is explicitly selected", async () => {
  delete h.disk.remote.config.targets[0].rangeMode; h.disk.policy.defaultScope = "full"; h.reset(); render(<Panel />);
  expect(screen.getByTestId("backup-cloud-range-mode")).toHaveValue("custom");
  expect(screen.getByTestId("backup-cloud-scope")).toHaveValue("core");
  fireEvent.change(screen.getByTestId("backup-cloud-range-mode"), { target: { value: "inherit" } });
  await settings.getState().flush();
  expect(h.disk.remote.config.targets[0].rangeMode).toBe("inherit");
  expect(screen.queryByTestId("backup-cloud-scope")).toBeNull();
});
it("opens only requested official links, ignores stale events, and never auto opens on remount", async () => {
  const view = render(<Panel />);
  fireEvent.click(screen.getByTestId("backup-feishu-authorize"));
  await waitFor(() => expect(control.getState().sessions).toHaveLength(1));
  const session = { ...control.getState().sessions[0], phase: "awaiting_authorization", revision: 2, verificationUrl: `https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=${crypto.randomUUID()}` };
  await publish(session); await waitFor(() => expect(mocks.open).toHaveBeenCalledWith(session.verificationUrl));
  await publish({ ...session, revision: 1, phase: "connected", verificationUrl: null });
  expect(screen.getByText(/Awaiting browser authorization/)).toBeDefined();
  h.sessions = [session]; view.unmount(); mocks.open.mockClear(); render(<Panel />);
  await screen.findByText(/Awaiting browser authorization/); expect(mocks.open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Open authorization page")); await waitFor(() => expect(mocks.open).toHaveBeenCalledWith(session.verificationUrl));
});
it("observes changed authorization and keeps remote device history/download behavior", async () => {
  h.disk.remote.statuses[0].connected = true; h.disk.remote.config.targets[0].enabled = true;
  h.files = [{ targetId: "target", deviceId: "other", deviceName: "Other", sourceKind: "taomni", fileToken: "file_fixture", name: "current.taobak", modifiedAt: "" }]; h.reset();
  render(<Panel />); fireEvent.click(screen.getByTestId("backup-cloud-refresh"));
  fireEvent.click(await screen.findByText("Feishu version history"));
  await screen.findByText("Restored in Feishu — download again");
  fireEvent.click(screen.getByText("Restored in Feishu — download again"));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("backup_remote_download", { remote: h.files[0] }));
  h.disk.remote.statuses[0].connected = false;
  await act(async () => mocks.events.get("backup-connection-changed")!({ payload: "connection" }));
  await waitFor(() => expect(screen.getByTestId("backup-cloud-refresh")).toBeDisabled());
  expect(within(screen.getByTestId("backup-cloud-destination")).getByTestId("backup-feishu-authorize")).toBeEnabled();
});
