import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteBackupPanel } from "./RemoteBackupPanel";
import { newFeishuTarget, type AuthorizationSession, type RemoteConfiguration } from "../../lib/remoteBackup";
import { setLocale } from "../../lib/i18n";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), open: vi.fn(), events: new Map<string, (event: { payload: unknown }) => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: mocks.open }));
vi.mock("./AppProxyPanel", () => ({ AppProxyPanel: () => <div>Proxy editor</div> }));

let config: RemoteConfiguration;
let sessions: AuthorizationSession[];
const waiting: AuthorizationSession = { id: "session", targetId: "target", createdAt: 100, revision: 2, phase: "awaiting_authorization", verificationUrl: "https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=fixture", userCode: "CODE", error: null };
beforeEach(() => {
  setLocale("zh-CN");
  vi.clearAllMocks(); mocks.events.clear(); sessions = [];
  config = { config: { formatVersion: 1, device: { id: "device", name: "Laptop" }, connections: [], targets: [{ ...newFeishuTarget(), id: "target", enabled: false, name: "My Feishu" }], selectedTargetIds: ["local"] }, statuses: [{ targetId: "target", connected: false, passwordConfigured: true }] };
  mocks.listen.mockImplementation(async (event: string, handler: (event: { payload: unknown }) => void) => { mocks.events.set(event, handler); return () => mocks.events.delete(event); });
  mocks.open.mockResolvedValue(undefined);
  mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "backup_remote_get_config") return config;
    if (cmd === "backup_remote_jobs" || cmd === "backup_feishu_apps") return [];
    if (cmd === "backup_feishu_authorization_status") return sessions;
    if (cmd === "backup_feishu_authorize") return { ...waiting, revision: 1, phase: "discovering", verificationUrl: null, userCode: null };
    if (cmd === "backup_remote_save_config") { config = { ...config, config: args!.config as RemoteConfiguration["config"] }; return; }
    return undefined;
  });
});
afterEach(() => { cleanup(); setLocale("en"); });

describe("Feishu native backup connection", () => {
  it("requires acknowledgement before restarting an expired application connection", async () => {
    setLocale("en");
    sessions = [{ ...waiting, phase: "expired", verificationUrl: null, error: "BACKUP_REGISTRATION_RECOVERY: expired" }];
    render(<RemoteBackupPanel onRestore={vi.fn()} />);
    const restart = await screen.findByTestId("backup-restart-application");
    expect((restart as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("backup-restart-confirm"));
    fireEvent.click(restart);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("backup_feishu_authorize", { targetId: "target", applicationSelection: null, restartApplication: true }));
  });
  it("refreshes connection status when background token refresh requires authorization", async () => {
    setLocale("en");
    config.config.targets[0].enabled = true;
    config.statuses[0].connected = true;
    render(<RemoteBackupPanel onRestore={vi.fn()} />);
    const start = await screen.findByTestId("backup-cloud-start");
    expect((start as HTMLButtonElement).disabled).toBe(false);
    config = { ...config, statuses: [{ ...config.statuses[0], connected: false }] };
    await act(async () => { mocks.events.get("backup-connection-changed")!({ payload: "connection" }); });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByTestId("backup-feishu-authorize") as HTMLButtonElement).disabled).toBe(false);
  });
  it("switches the mounted workflow, pending authorization, errors and notices between languages", async () => {
    setLocale("en");
    sessions = [{ ...waiting, error: "Cannot read the system credential store; unlock it and retry" }];
    render(<RemoteBackupPanel onRestore={vi.fn()} />);
    expect(await screen.findByText("Awaiting browser authorization · Verification code: CODE")).toBeDefined();
    expect(screen.getByText("Could not access the system credential store. Unlock it or check system permissions, then retry.")).toBeDefined();
    expect(screen.queryByText("添加飞书目标")).toBeNull();
    fireEvent.click(screen.getByTestId("backup-cloud-edit"));
    expect(screen.getByLabelText("Cloud backup proxy")).toBeDefined();
    fireEvent.click(screen.getByTestId("backup-cloud-save"));
    await screen.findByText("Saved. New cloud backups use the independent encryption password.");
    await act(async () => setLocale("zh-CN"));
    expect(screen.getByText("等待浏览器授权 · 验证码：CODE")).toBeDefined();
    expect(screen.getByText("已保存，云端新备份使用独立密码加密")).toBeDefined();
    expect(screen.getByText("无法访问系统凭据库，请解锁或检查系统权限后重试。")).toBeDefined();
    expect(screen.getByText("添加飞书目标")).toBeDefined();
  });
  it("saves a target without app credentials and with its own proxy", async () => {
    render(<RemoteBackupPanel onRestore={vi.fn()} />);
    fireEvent.click(await screen.findByText("连接与代理设置"));
    expect(screen.queryByText("App ID")).toBeNull(); expect(screen.queryByText(/App Secret/)).toBeNull(); expect(screen.queryByText(/回调端口/)).toBeNull();
    fireEvent.change(screen.getByLabelText("云备份代理"), { target: { value: "none" } });
    fireEvent.click(screen.getByTestId("backup-cloud-save"));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("backup_remote_save_config", expect.objectContaining({ targetId: "target" })));
    const args = mocks.invoke.mock.calls.find(([cmd]) => cmd === "backup_remote_save_config")![1];
    expect(args).not.toHaveProperty("appSecret"); expect(args.config.targets[0].proxy.mode).toBe("none"); expect(args.config.targets[0].rootToken).toBe("");
  });

  it("opens only official session links, ignores stale events, and restores pending state after remount", async () => {
    const view = render(<RemoteBackupPanel onRestore={vi.fn()} />);
    fireEvent.click(await screen.findByTestId("backup-feishu-authorize"));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("backup_feishu_authorize", { targetId: "target", applicationSelection: null, restartApplication: false }));
    await act(async () => { sessions = [waiting]; mocks.events.get("backup-authorization")!({ payload: waiting }); });
    await waitFor(() => expect(mocks.open).toHaveBeenCalledWith(waiting.verificationUrl));
    await act(async () => { mocks.events.get("backup-authorization")!({ payload: { ...waiting, revision: 1, phase: "connected", verificationUrl: null } }); });
    expect(screen.getByText(/等待浏览器授权/)).toBeDefined();
    view.unmount(); mocks.open.mockClear();
    render(<RemoteBackupPanel onRestore={vi.fn()} />);
    expect(await screen.findByText(/等待浏览器授权/)).toBeDefined(); expect(mocks.open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("打开授权网页")); await waitFor(() => expect(mocks.open).toHaveBeenCalledWith(waiting.verificationUrl));
    fireEvent.click(screen.getByText("取消连接")); await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("backup_feishu_authorization_cancel", { sessionId: "session" }));
  });

  it("can use a saved connection and requests a fresh current download after web history recovery", async () => {
    config.config.connections = [{ id: "connection", appId: "cli_fixture", label: "Existing", origin: "cli_existing", accountId: "ou_fixture", accountName: "User", tenantKey: "tenant", registrationPending: false }];
    config.config.targets[0].connectionId = "connection"; config.statuses[0].connected = true;
    const file = { targetId: "target", deviceId: "other", deviceName: "Other", sourceKind: "taomni", fileToken: "file_fixture", name: "current.taobak", modifiedAt: "" };
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "backup_remote_get_config") return config;
      if (cmd === "backup_remote_list") return [file];
      if (cmd === "backup_remote_history_url") { config.config.targets[0].writesPaused = true; return "https://my.feishu.cn/file/file_fixture"; }
      return [];
    });
    render(<RemoteBackupPanel onRestore={vi.fn()} />);
    await screen.findByText(/飞书账户：User/);
    fireEvent.click(screen.getByTestId("backup-cloud-refresh")); await screen.findByText("飞书历史版本");
    fireEvent.click(screen.getByText("飞书历史版本")); await screen.findByText("已在飞书恢复，重新下载");
    fireEvent.click(screen.getByText("已在飞书恢复，重新下载"));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("backup_remote_download", { remote: file }));
  });
});
