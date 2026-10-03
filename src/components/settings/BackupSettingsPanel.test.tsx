import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupSettingsPanel } from "./BackupSettingsPanel";
import { useBackupStore } from "../../stores/backupStore";
import { useVaultStore } from "../../stores/vaultStore";

const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("../../lib/ipc", () => ({
  openLocalPath: vi.fn(),
  selectFilePath: vi.fn(),
  selectSaveDirectory: vi.fn(),
  selectSaveFilePath: vi.fn(),
}));

vi.mock("../../lib/updateService", () => ({
  relaunchApp: vi.fn(),
}));

describe("BackupSettingsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenMock.mockResolvedValue(vi.fn());
    const policy = {
      autoBackupEnabled: false,
      frequency: "weekly" as const,
      customBackupDir: null,
      maxRetainedCopies: 7,
      defaultScope: "core",
      lastBackupAt: null,
    };
    const defaultBackupDir = "C:\\Users\\test\\AppData\\Roaming\\com.taomni.app\\backups";
    const history = [
      {
        fileName: "taomni_backup_20260904_120000.taobak",
        filePath: "C:\\Users\\test\\AppData\\Roaming\\com.taomni.app\\backups\\taomni_backup_20260904_120000.taobak",
        sizeBytes: 2097152,
        modifiedAt: 1788500000000,
        isEncrypted: false,
      },
    ];

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "backup_get_policy") return Promise.resolve(useBackupStore.getState().policy ?? policy);
      if (cmd === "backup_get_default_dir") return Promise.resolve(defaultBackupDir);
      if (cmd === "backup_list_history") return Promise.resolve(useBackupStore.getState().history.length > 0 ? useBackupStore.getState().history : history);
      return Promise.resolve(null);
    });

    useBackupStore.setState({
      policy,
      defaultBackupDir,
      history,
      loading: false,
      creating: false,
      restoring: false,
      lastResult: null,
      error: null,
    });

    useVaultStore.setState({
      state: "unlocked",
      entryCount: 1,
      loading: false,
      entries: [],
      refresh: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders backup storage directory and default path badge", () => {
    render(<BackupSettingsPanel />);

    expect(screen.getByText("Backup Storage Directory")).toBeDefined();
    expect(screen.getByText("Default Path")).toBeDefined();
    expect(
      screen.getByDisplayValue("C:\\Users\\test\\AppData\\Roaming\\com.taomni.app\\backups"),
    ).toBeDefined();
  });

  it("shows custom directory badge and reset button when customBackupDir is set", () => {
    useBackupStore.setState({
      policy: {
        autoBackupEnabled: false,
        frequency: "weekly",
        customBackupDir: "D:\\OneDrive\\TaomniBackups",
        maxRetainedCopies: 7,
        defaultScope: "core",
        lastBackupAt: null,
      },
    });

    render(<BackupSettingsPanel />);

    expect(screen.getByText("Custom Directory")).toBeDefined();
    expect(screen.getByDisplayValue("D:\\OneDrive\\TaomniBackups")).toBeDefined();
    expect(screen.getByText("Reset to Default")).toBeDefined();
  });

  it("renders backup history and actions", () => {
    render(<BackupSettingsPanel />);

    expect(screen.getByText(/Historical Snapshots/)).toBeDefined();
    expect(screen.getByText("taomni_backup_20260904_120000.taobak")).toBeDefined();
    expect(screen.getByText("2.00 MB")).toBeDefined();
    expect(screen.getByText("Restore")).toBeDefined();
    expect(screen.getByText("Delete")).toBeDefined();
  });

  it("renders the restore dialog on an opaque theme surface", () => {
    render(<BackupSettingsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    const dialog = screen.getByTestId("backup-restore-dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveProperty("style.background", "var(--taomni-bg)");
    expect(dialog).toHaveProperty("style.borderColor", "var(--taomni-card-border)");
  });

  it("renders manual backup controls with Backup Now and Export to... buttons without requiring vault password during creation", () => {
    useVaultStore.setState({ state: "unlocked" });
    render(<BackupSettingsPanel />);

    expect(screen.getByText("Manual Instant Backup")).toBeDefined();
    expect(screen.getByText("Backup Now")).toBeDefined();
    expect(screen.getByText("Export to...")).toBeDefined();
    // Manual backup should not have vault master password requirement
    expect(screen.queryByText("Vault Master Password Verification")).toBeNull();
  });

  it("renders auto-backup toggle card and weekly retention hint", () => {
    useBackupStore.setState({
      policy: {
        autoBackupEnabled: true,
        frequency: "weekly",
        customBackupDir: null,
        maxRetainedCopies: 7,
        defaultScope: "core",
        lastBackupAt: null,
      },
    });

    render(<BackupSettingsPanel />);
    expect(screen.getByText("Enable scheduled rolling backup in background")).toBeDefined();
    expect(
      screen.getByText("Weekly backup, defaults to keeping 7 weeks of historical snapshots"),
    ).toBeDefined();
  });

  it("updates the open history and last backup time after a background backup completes", async () => {
    render(<BackupSettingsPanel />);
    await waitFor(() => expect(useBackupStore.getState().loading).toBe(false));
    const policy = { ...useBackupStore.getState().policy!, lastBackupAt: 1788501000000 };
    const history = [{
      fileName: "taomni_backup_auto_daily.taobak",
      filePath: "/backups/taomni_backup_auto_daily.taobak",
      sizeBytes: 2048,
      modifiedAt: policy.lastBackupAt,
      isEncrypted: false,
    }];
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "backup_get_policy") return Promise.resolve(policy);
      if (cmd === "backup_list_history") return Promise.resolve(history);
      return Promise.resolve(null);
    });

    expect(listenMock).toHaveBeenCalledWith("backup-completed", expect.any(Function));
    await act(async () => {
      listenMock.mock.calls[0][1]({ payload: {} });
    });

    expect(screen.getByText(history[0].fileName)).toBeDefined();
    expect(screen.getByTestId("backup-last-success")).toHaveTextContent(new Date(policy.lastBackupAt).toLocaleString());
    expect(screen.queryByText("taomni_backup_20260904_120000.taobak")).toBeNull();
  });

  it("observes another instance's backup without a local event and stops polling when closed", async () => {
    vi.useFakeTimers();
    const { unmount } = render(<BackupSettingsPanel />);
    await act(async () => {});
    const policy = { ...useBackupStore.getState().policy!, lastBackupAt: 1788501000000 };
    const history = [{
      fileName: "taomni_backup_other_instance.taobak",
      filePath: "/backups/taomni_backup_other_instance.taobak",
      sizeBytes: 2048,
      modifiedAt: policy.lastBackupAt,
      isEncrypted: false,
    }];
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "backup_get_policy") return Promise.resolve(policy);
      if (cmd === "backup_list_history") return Promise.resolve(history);
      return Promise.resolve(null);
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });

    expect(screen.getByText(history[0].fileName)).toBeDefined();
    expect(screen.getByTestId("backup-last-success")).toHaveTextContent(new Date(policy.lastBackupAt).toLocaleString());
    unmount();
    invokeMock.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("removes a listener whose registration finishes after the panel closes", async () => {
    const unlisten = vi.fn();
    let registered!: (unlisten: () => void) => void;
    listenMock.mockReturnValue(new Promise<() => void>((resolve) => { registered = resolve; }));
    const { unmount } = render(<BackupSettingsPanel />);
    unmount();

    await act(async () => { registered(unlisten); });

    expect(unlisten).toHaveBeenCalledOnce();
  });
});
