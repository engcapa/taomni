import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../../stores/appStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { WelcomePanel } from "../../WelcomePanel";
import { emitWelcomeDirectoriesChanged, ipcMocks, restoreRecord, savedRestoreEntry } from "./harness";

export function registerWelcomePanelLayout2Cases() {

  describe("WelcomePanel directory ordering, time and errors (V-04)", () => {
    beforeEach(() => {
      ipcMocks.listLocalShells.mockResolvedValue([
        { id: "powershell", name: "PowerShell", path: "powershell.exe", isDefault: true, canElevate: true },
      ]);
      ipcMocks.listSessions.mockResolvedValue([]);
      ipcMocks.listSessionGroups.mockResolvedValue([]);
      ipcMocks.listWslDistros.mockResolvedValue([]);
      ipcMocks.openLocalShellAsAdministrator.mockResolvedValue(undefined);
      ipcMocks.saveSession.mockResolvedValue(undefined);
      ipcMocks.listenWelcomeDirectoriesChanged.mockImplementation(
        async (callback: (revision: number) => void) => {
          ipcMocks.directoryEventListeners.push(callback);
          return () => {
            ipcMocks.directoryEventListeners = ipcMocks.directoryEventListeners.filter(
              (cb) => cb !== callback,
            );
          };
        },
      );
      ipcMocks.directoryEventListeners.length = 0;
      useAppStore.setState({
        tabs: [{ id: "welcome", type: "welcome", title: "Welcome", closable: false }],
        activeTabId: "welcome",
        statusMessage: "Ready",
      });
      useSessionStore.setState({ sessions: [], groups: [], loading: false });
    });

    afterEach(() => {
      cleanup();
      vi.clearAllMocks();
    });

    const usedRow = (path: string, ms: number, label: string) => ({
      label,
      path,
      kind: "personal",
      directoryId: `id-${path}`,
      lastUsedAtMs: ms,
      timeSource: "local-start",
      legacyRank: null,
      defaultId: null,
      availability: "available",
    });

    it("keeps the backend mixed order and exposes time attributes", async () => {
      ipcMocks.listCommonLocalDirectories.mockResolvedValue({
        revision: 3,
        directories: [
          usedRow("/work/A", 3000, "A"),
          { label: "Downloads", path: "/x/Downloads", kind: "system", directoryId: "id-dl", lastUsedAtMs: 1000, timeSource: "local-cwd", legacyRank: null, defaultId: "downloads", availability: "available" },
          { label: "Home", path: "/home/test", kind: "system", directoryId: "id-home", lastUsedAtMs: null, timeSource: null, legacyRank: 2, defaultId: "home", availability: "available" },
          { label: "Fresh", path: "/x/Fresh", kind: "personal", directoryId: "id-fresh", lastUsedAtMs: null, timeSource: null, legacyRank: null, defaultId: null, availability: "unknown" },
        ],
      });
      render(<WelcomePanel onStartLocalTerminal={vi.fn()} onNewSession={vi.fn()} />);
      fireEvent.click(screen.getByTestId("welcome-history-tab-directories"));

      await waitFor(() => {
        expect(screen.getAllByTestId("welcome-local-directory")).toHaveLength(4);
      });
      const rows = screen.getAllByTestId("welcome-local-directory");
      expect(rows.map((row) => row.getAttribute("data-directory-path"))).toEqual([
        "/work/A",
        "/x/Downloads",
        "/home/test",
        "/x/Fresh",
      ]);
      expect(rows[0].getAttribute("data-last-used-at-ms")).toBe("3000");
      expect(rows[1].getAttribute("data-last-used-at-ms")).toBe("1000");
      // Legacy observation: null confirmed time, tooltip says time unknown.
      expect(rows[2].getAttribute("data-last-used-at-ms")).toBe("");
      expect(rows[2].getAttribute("title")).toMatch(/unknown|未知/);
      // Fresh default: never used.
      expect(rows[3].getAttribute("title")).toMatch(/Not used|尚未使用/);
      expect(rows[0].querySelector('[data-testid="welcome-local-directory-last-used"]')).not.toBeNull();
      expect(rows[2].textContent).toMatch(/unknown|未知/);
      expect(rows[3].textContent).not.toMatch(/unknown|未知/);
    });

    it("preserves relative order after filtering and clearing", async () => {
      ipcMocks.listCommonLocalDirectories.mockResolvedValue({
        revision: 1,
        directories: [
          usedRow("/work/A", 3000, "A"),
          usedRow("/work/B", 2000, "B"),
          usedRow("/x/Downloads", 1000, "Downloads"),
        ],
      });
      render(<WelcomePanel onStartLocalTerminal={vi.fn()} onNewSession={vi.fn()} />);
      fireEvent.click(screen.getByTestId("welcome-history-tab-directories"));
      await waitFor(() => {
        expect(screen.getAllByTestId("welcome-local-directory")).toHaveLength(3);
      });

      const filter = screen.getByTestId("welcome-local-directory-filter");
      fireEvent.change(filter, { target: { value: "work" } });
      const rows = screen.getAllByTestId("welcome-local-directory");
      expect(rows.map((row) => row.getAttribute("data-directory-path"))).toEqual(["/work/A", "/work/B"]);

      fireEvent.change(filter, { target: { value: "" } });
      const restored = screen.getAllByTestId("welcome-local-directory");
      expect(restored.map((row) => row.getAttribute("data-directory-path"))).toEqual([
        "/work/A",
        "/work/B",
        "/x/Downloads",
      ]);
    });

    it("keeps the last list when a refresh fails and offers retry", async () => {
      ipcMocks.listCommonLocalDirectories.mockResolvedValueOnce({
        revision: 1,
        directories: [usedRow("/work/A", 3000, "A")],
      });
      ipcMocks.listCommonLocalDirectories.mockRejectedValueOnce(new Error("db busy"));
      ipcMocks.listCommonLocalDirectories.mockRejectedValue(new Error("db busy"));

      render(<WelcomePanel onStartLocalTerminal={vi.fn()} onNewSession={vi.fn()} />);
      fireEvent.click(screen.getByTestId("welcome-history-tab-directories"));
      await waitFor(() => {
        expect(screen.getAllByTestId("welcome-local-directory")).toHaveLength(1);
      });

      // A backend revision event triggers the failing refresh.
      act(() => {
        emitWelcomeDirectoriesChanged(2);
      });
      await waitFor(() => {
        expect(screen.getByTestId("welcome-directory-retry")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId("welcome-directory-retry"));
      await waitFor(() => {
        // Initial load + failed event refresh + the explicit retry.
        expect(ipcMocks.listCommonLocalDirectories).toHaveBeenCalledTimes(3);
      });
      // The previous array is preserved; a retry control is still offered.
      expect(screen.getAllByTestId("welcome-local-directory")).toHaveLength(1);
      expect(screen.getByTestId("welcome-directory-retry")).toBeInTheDocument();
    });

    it("shows the error state (not an empty list) on first-load failure", async () => {
      ipcMocks.listCommonLocalDirectories.mockRejectedValue(new Error("storage unavailable"));
      render(<WelcomePanel onStartLocalTerminal={vi.fn()} onNewSession={vi.fn()} />);
      fireEvent.click(screen.getByTestId("welcome-history-tab-directories"));
      await waitFor(() => {
        expect(screen.getByTestId("welcome-local-directories-error")).toBeInTheDocument();
      });
      expect(screen.queryByTestId("welcome-local-directory")).not.toBeInTheDocument();
      expect(screen.getByTestId("welcome-directory-retry")).toBeInTheDocument();
    });

    it("marks the directory row pending and does not double-dispatch", async () => {
      ipcMocks.listCommonLocalDirectories.mockResolvedValue({
        revision: 1,
        directories: [usedRow("/work/A", 3000, "A")],
      });
      let release!: (value: unknown) => void;
      const startLocalTerminal = vi.fn(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      render(
        <WelcomePanel onStartLocalTerminal={startLocalTerminal as never} onNewSession={vi.fn()} />,
      );
      fireEvent.click(screen.getByTestId("welcome-history-tab-directories"));
      await waitFor(() => {
        expect(screen.getAllByTestId("welcome-local-directory")).toHaveLength(1);
      });

      const row = screen.getAllByTestId("welcome-local-directory")[0];
      fireEvent.click(row);
      expect(startLocalTerminal).toHaveBeenCalledTimes(1);
      // Row is disabled while pending; a second click dispatches nothing.
      expect(screen.getAllByTestId("welcome-local-directory")[0]).toBeDisabled();
      fireEvent.click(screen.getAllByTestId("welcome-local-directory")[0]);
      expect(startLocalTerminal).toHaveBeenCalledTimes(1);

      await act(async () => {
        release({ tabId: "tab-1", status: "started" });
      });
      await waitFor(() => {
        expect(screen.getAllByTestId("welcome-local-directory")[0]).toBeEnabled();
      });
    });

    it("reports a failed launch without changing the directory list", async () => {
      ipcMocks.listCommonLocalDirectories.mockResolvedValue({
        revision: 1,
        directories: [usedRow("/work/A", 3000, "A")],
      });
      const { setStatusMessage: _unused } = useAppStore.getState();
      const startLocalTerminal = vi.fn(async () => ({
        tabId: "tab-1",
        status: "failed" as const,
        error: "pty spawn failed",
      }));
      render(
        <WelcomePanel onStartLocalTerminal={startLocalTerminal as never} onNewSession={vi.fn()} />,
      );
      fireEvent.click(screen.getByTestId("welcome-history-tab-directories"));
      await waitFor(() => {
        expect(screen.getAllByTestId("welcome-local-directory")).toHaveLength(1);
      });
      fireEvent.click(screen.getAllByTestId("welcome-local-directory")[0]);
      await waitFor(() => {
        expect(useAppStore.getState().statusMessage).toMatch(/pty spawn failed|启动终端失败/);
      });
      // List order and time unchanged by the failed launch.
      const rows = screen.getAllByTestId("welcome-local-directory");
      expect(rows).toHaveLength(1);
      expect(rows[0].getAttribute("data-last-used-at-ms")).toBe("3000");
    });

    it("marks unavailable directories and keeps them clickable for retry", async () => {
      ipcMocks.listCommonLocalDirectories.mockResolvedValue({
        revision: 1,
        directories: [
          usedRow("/offline/mount", 5000, "Offline mount"),
        ].map((row) => ({ ...row, availability: "missing" })),
      });
      const startLocalTerminal = vi.fn();
      render(<WelcomePanel onStartLocalTerminal={startLocalTerminal as never} onNewSession={vi.fn()} />);
      fireEvent.click(screen.getByTestId("welcome-history-tab-directories"));
      await waitFor(() => {
        expect(screen.getAllByTestId("welcome-local-directory")).toHaveLength(1);
      });
      const row = screen.getAllByTestId("welcome-local-directory")[0];
      expect(row.getAttribute("data-availability")).toBe("missing");
      expect(screen.getByTestId("welcome-local-directory-unavailable")).toBeInTheDocument();

      fireEvent.click(row);
      await waitFor(() => {
        expect(startLocalTerminal).toHaveBeenCalledTimes(1);
      });
      // The row and its (unchanged) time remain listed.
      const after = screen.getAllByTestId("welcome-local-directory");
      expect(after[0].getAttribute("data-last-used-at-ms")).toBe("5000");
    });
  });

  describe("WelcomePanel restore row (V-07 UI)", () => {
    const setup = (props: Record<string, unknown>) => {
      ipcMocks.listLocalShells.mockResolvedValue([
        { id: "powershell", name: "PowerShell", path: "powershell.exe", isDefault: true, canElevate: true },
      ]);
      ipcMocks.listSessions.mockResolvedValue([]);
      ipcMocks.listSessionGroups.mockResolvedValue([]);
      ipcMocks.listWslDistros.mockResolvedValue([]);
      ipcMocks.listCommonLocalDirectories.mockResolvedValue({ revision: 1, directories: [] });
      useAppStore.setState({
        tabs: [{ id: "welcome", type: "welcome", title: "Welcome", closable: false }],
        activeTabId: "welcome",
        statusMessage: "Ready",
      });
      useSessionStore.setState({ sessions: [], groups: [], loading: false });
      return render(
        <WelcomePanel
          onStartLocalTerminal={vi.fn()}
          onNewSession={vi.fn()}
          restore={props as never}
        />,
      );
    };

    afterEach(() => {
      cleanup();
      vi.clearAllMocks();
    });

    it("shows an empty disabled state", () => {
      setup({
        view: { state: "empty" },
        outcomes: [],
        onStartRestore: vi.fn(),
        onRetryFailed: vi.fn(),
        onCancelRestore: vi.fn(),
        onClearRecord: vi.fn(),
      });
      const status = screen.getByTestId("welcome-restore-status");
      expect(status).toHaveAttribute("data-state", "empty");
      expect(screen.getByTestId("welcome-restore-last-session")).toBeDisabled();
    });

    it("shows the available state with entry summary and enables restore", async () => {
      const onStartRestore = vi.fn();
      setup({
        view: { state: "available", record: restoreRecord([savedRestoreEntry("a"), savedRestoreEntry("b")]), legacy: false },
        outcomes: [],
        onStartRestore,
        onRetryFailed: vi.fn(),
        onCancelRestore: vi.fn(),
        onClearRecord: vi.fn(),
      });
      const status = screen.getByTestId("welcome-restore-status");
      expect(status).toHaveAttribute("data-state", "available");
      const button = screen.getByTestId("welcome-restore-last-session");
      expect(button).toBeEnabled();
      expect(status.textContent).toContain("2");
      fireEvent.click(button);
      expect(onStartRestore).toHaveBeenCalledTimes(1);
    });

    it("marks a legacy candidate source", () => {
      setup({
        view: { state: "available", record: restoreRecord([savedRestoreEntry("legacy")]), legacy: true },
        outcomes: [],
        onStartRestore: vi.fn(),
        onRetryFailed: vi.fn(),
        onCancelRestore: vi.fn(),
        onClearRecord: vi.fn(),
      });
      expect(screen.getByTestId("welcome-restore-status").getAttribute("data-state")).toBe("available");
      expect(screen.getByTestId("welcome-restore-status").textContent).toMatch(/legacy|历史|来源/);
    });

    it("disables the button and shows cancel while restoring", () => {
      const onCancelRestore = vi.fn();
      setup({
        view: {
          state: "restoring",
          record: restoreRecord([savedRestoreEntry("a"), savedRestoreEntry("b")]),
          operationId: "op-1",
          completed: 1,
          total: 2,
          awaitingEntry: null,
        },
        outcomes: [],
        onStartRestore: vi.fn(),
        onRetryFailed: vi.fn(),
        onCancelRestore,
        onClearRecord: vi.fn(),
      });
      const status = screen.getByTestId("welcome-restore-status");
      expect(status).toHaveAttribute("data-state", "restoring");
      expect(screen.getByTestId("welcome-restore-last-session")).toBeDisabled();
      expect(screen.getByTestId("welcome-restore-last-session")).toHaveAttribute("aria-busy", "true");
      fireEvent.click(screen.getByTestId("welcome-restore-cancel"));
      expect(onCancelRestore).toHaveBeenCalledTimes(1);
    });

    it("lists failed entries under partial and offers retry only for failures", () => {
      const onRetryFailed = vi.fn();
      setup({
        view: {
          state: "partial",
          record: restoreRecord([savedRestoreEntry("a"), savedRestoreEntry("b")]),
          operationId: "op-1",
        },
        outcomes: [
          { identity: "saved:a", kind: "saved-session", displayName: "session-a", status: "ready", readiness: "connected", tabId: "t1", issue: null },
          { identity: "saved:b", kind: "saved-session", displayName: "session-b", status: "failed", readiness: null, tabId: null, issue: { code: "connect", message: "refused" } },
        ],
        onStartRestore: vi.fn(),
        onRetryFailed,
        onCancelRestore: vi.fn(),
        onClearRecord: vi.fn(),
      });
      expect(screen.getByTestId("welcome-restore-status").getAttribute("data-state")).toBe("partial");
      expect(screen.getByTestId("welcome-restore-status").textContent).toContain("session-b");
      expect(screen.getByTestId("welcome-restore-status").textContent).toContain("connect");
      fireEvent.click(screen.getByTestId("welcome-restore-retry"));
      expect(onRetryFailed).toHaveBeenCalledTimes(1);
    });

    it("reports an incompatible snapshot as unavailable without pretending empty", () => {
      setup({
        view: { state: "unavailable", reason: "schema", message: "schema version 99 is not supported" },
        outcomes: [],
        onStartRestore: vi.fn(),
        onRetryFailed: vi.fn(),
        onCancelRestore: vi.fn(),
        onClearRecord: vi.fn(),
      });
      expect(screen.getByTestId("welcome-restore-status").getAttribute("data-state")).toBe("unavailable");
      expect(screen.getByTestId("welcome-restore-last-session")).toBeDisabled();
    });

    it("clears the record through the confirm dialog", async () => {
      const onClearRecord = vi.fn();
      setup({
        view: { state: "available", record: restoreRecord([savedRestoreEntry("a")]), legacy: false },
        outcomes: [],
        onStartRestore: vi.fn(),
        onRetryFailed: vi.fn(),
        onCancelRestore: vi.fn(),
        onClearRecord,
      });
      fireEvent.click(screen.getByTestId("welcome-restore-clear"));
      // ConfirmDialog appears; click its confirm action.
      await waitFor(() => {
        expect(screen.getByRole("dialog", { hidden: true }) || screen.getByText(/Clear restore record|清除恢复记录/)).toBeTruthy();
      });
      const confirmButton = screen.getAllByRole("button").find((button) =>
        /Clear$|清除/.test(button.textContent ?? ""),
      );
      if (confirmButton) fireEvent.click(confirmButton);
      await waitFor(() => {
        expect(onClearRecord).toHaveBeenCalled();
      });
    });
  });
}
