import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { exitApp, type SessionConfig } from "../../../lib/ipc";
import { DEFAULT_TERMINAL_PROFILE } from "../../../lib/terminalProfile";
import { recentWorkspaceIdFromParts, useAppStore } from "../../../stores/appStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { useWorkspacePlatformStore } from "../../../stores/workspacePlatformStore";
import { MainLayout } from "../../MainLayout";
import { controlBarMock, setNavigatorPlatform, sftpSidebarMock, terminalLifecycle, terminalPanelMock } from "./harness";

export function registerMainLayoutLifecycle2Cases() {

  it("opens the attached SFTP sidebar without remounting the terminal", () => {
    render(<MainLayout />);

    expect(screen.getByTestId("terminal-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-chat-drawer-ribbon")).not.toBeInTheDocument();
    expect(terminalLifecycle.mounted).toHaveBeenCalledTimes(1);
    expect(terminalLifecycle.unmounted).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /sftp/i }));

    expect(screen.getByTestId("sftp-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-panel")).toBeInTheDocument();
    expect(terminalLifecycle.mounted).toHaveBeenCalledTimes(1);
    expect(terminalLifecycle.unmounted).not.toHaveBeenCalled();
  });

  it("opens attached SFTP with a pending upload request from the terminal", async () => {
    render(<MainLayout />);

    const terminalProps = terminalPanelMock.props.find((props) => props.tabId === "ssh-tab");
    expect(terminalProps?.onUploadLocalPaths).toEqual(expect.any(Function));

    await act(async () => {
      await terminalProps!.onUploadLocalPaths!({
        paths: ["/tmp/drop.png"],
        cwd: "/home/root",
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("sftp-sidebar")).toBeInTheDocument();
    });
    const sidebarProps = sftpSidebarMock.props.at(-1);
    expect(sidebarProps.pendingUploadRequest).toMatchObject({
      paths: ["/tmp/drop.png"],
      remoteDir: "/home/root",
    });
    expect(sidebarProps.pendingUploadRequest.id).toEqual(expect.any(Number));

    act(() => {
      sidebarProps.onPendingUploadRequestHandled(sidebarProps.pendingUploadRequest.id);
    });

    await waitFor(() => {
      expect(sftpSidebarMock.props.at(-1).pendingUploadRequest).toBeNull();
    });
  });

  it("toggles the attached SFTP sidebar and handles detaching and reopening behavior", () => {
    const windowOpenSpy = vi.spyOn(window, "open").mockImplementation(() => null as any);
    render(<MainLayout />);

    // Click SFTP button to open sidebar
    fireEvent.click(screen.getByRole("button", { name: /sftp/i }));
    expect(screen.getByTestId("sftp-sidebar")).toBeInTheDocument();

    // Click Close inside the mock sidebar (should hide sidebar)
    fireEvent.click(screen.getByTestId("sftp-mock-close"));
    expect(screen.queryByTestId("sftp-sidebar")).not.toBeInTheDocument();

    // Click SFTP button to show sidebar again
    fireEvent.click(screen.getByRole("button", { name: /sftp/i }));
    expect(screen.getByTestId("sftp-sidebar")).toBeInTheDocument();

    // Click Detach in the mock sidebar (should open detached window and close sidebar)
    fireEvent.click(screen.getByTestId("sftp-mock-detach"));
    expect(windowOpenSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("sftp-sidebar")).not.toBeInTheDocument();

    // Click SFTP button now that it's detached (should call window.open again, NOT open sidebar)
    fireEvent.click(screen.getByRole("button", { name: /sftp/i }));
    expect(windowOpenSpy).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("sftp-sidebar")).not.toBeInTheDocument();

    windowOpenSpy.mockRestore();
  });

  it("renders the unified control bar and status bar without remounting the terminal", () => {
    render(<MainLayout />);

    expect(screen.getByTestId("control-bar")).toBeInTheDocument();
    expect(screen.queryByTestId("quick-connect")).not.toBeInTheDocument();
    expect(screen.getByTestId("status-bar")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-panel")).toBeInTheDocument();
    expect(terminalLifecycle.mounted).toHaveBeenCalledTimes(1);
    expect(terminalLifecycle.unmounted).not.toHaveBeenCalled();
    expect(controlBarMock.props.at(-1)?.onDetachActiveTab).toEqual(expect.any(Function));
  });

  it("opens settings from the lower-left sidebar rail button", () => {
    render(<MainLayout />);

    fireEvent.click(screen.getByTestId("ribbon-settings"));

    expect(screen.getByTestId("settings-panel")).toBeInTheDocument();
    expect(useAppStore.getState().activeTabId).toBe("settings");
  });

  it("keeps the settings tab mounted when switching away", async () => {
    useAppStore.setState({
      tabs: [
        ...useAppStore.getState().tabs,
        { id: "settings", type: "settings", title: "Settings", closable: true },
      ],
      activeTabId: "settings",
    });

    render(<MainLayout />);

    const wrapper = screen.getByTestId("settings-tab-panel") as HTMLElement;
    const panel = screen.getByTestId("settings-panel");
    expect(wrapper.style.display).toBe("block");

    act(() => {
      useAppStore.getState().setActiveTab("ssh-tab");
    });

    await waitFor(() => {
      expect(wrapper.style.display).toBe("none");
    });
    expect(panel).toBeInTheDocument();

    act(() => {
      useAppStore.getState().setActiveTab("settings");
    });

    await waitFor(() => {
      expect(wrapper.style.display).toBe("block");
    });
  });

  it("keeps the welcome tab mounted when switching away", async () => {
    useAppStore.setState({
      tabs: [
        { id: "welcome", type: "welcome", title: "Welcome", closable: false },
        { id: "ssh-tab", type: "terminal", title: "SSH", closable: true },
      ],
      activeTabId: "welcome",
      activeSideTab: "home",
    });

    render(<MainLayout />);

    const wrapper = screen.getByTestId("welcome-tab-panel") as HTMLElement;
    const panel = screen.getByTestId("welcome-panel");
    expect(wrapper.style.display).toBe("block");

    act(() => {
      useAppStore.getState().setActiveTab("ssh-tab");
    });

    await waitFor(() => {
      expect(wrapper.style.display).toBe("none");
    });
    expect(panel).toBeInTheDocument();

    act(() => {
      useAppStore.getState().setActiveTab("welcome");
    });

    await waitFor(() => {
      expect(wrapper.style.display).toBe("block");
    });
    expect(panel).toBeInTheDocument();
  });

  it("derives the code workspace instance id from the workspace identity on recents re-entry", async () => {
    // ED-AUDIT-009 A3: the layout v2 snapshot and bounded recovery copies are
    // keyed by the workspace instance id, so re-entering a recents workspace
    // must reuse the deterministic identity instead of minting a fresh uuid
    // (which orphaned every snapshot/recovery entry across reload/restart).
    useAppStore.setState({
      tabs: [{ id: "welcome", type: "welcome", title: "Welcome", closable: false }],
      activeTabId: "welcome",
      recentWorkspaces: [
        {
          // Deliberately differs from the derived identity to prove the
          // instance id is derived from the workspace parts, not copied.
          id: "seeded-recents-id",
          name: "ws-audit009",
          roots: [{ id: "root-1", name: "ws-audit009", path: "/tmp/ws-audit009", kind: "folder" }],
          looseFiles: [],
          lastActiveFile: null,
          lastOpenedAt: 1756100000000,
          isGitRepo: false,
        },
      ],
    });

    render(<MainLayout />);

    fireEvent.click(screen.getByTestId("welcome-history-tab-workspaces"));
    fireEvent.click(screen.getByTestId("welcome-recent-workspace-row"));

    await waitFor(() => {
      const workspace = useWorkspacePlatformStore.getState().getWorkspace();
      expect(workspace?.codeWorkspace?.workspaceInstanceId).toBeTruthy();
    });
    const tab = useWorkspacePlatformStore.getState().getWorkspace()!;
    expect(useAppStore.getState().activeSideTab).toBe("workspaces");
    expect(useAppStore.getState().tabs.some((entry) => entry.type === "code-workspace")).toBe(false);
    expect(tab.codeWorkspace?.workspaceInstanceId).not.toMatch(/^workspace-instance-/);
    expect(tab.codeWorkspace?.workspaceInstanceId).toBe(
      recentWorkspaceIdFromParts(tab.codeWorkspace?.roots ?? [], tab.codeWorkspace?.looseFiles ?? []),
    );
  });

  it("routes titlebar close through the app exit command", async () => {
    render(<MainLayout />);

    fireEvent.click(screen.getByTestId("window-close"));

    expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));

    await waitFor(() => {
      expect(exitApp).toHaveBeenCalledTimes(1);
    });
  });

  it("routes the app menu exit through the app exit command", async () => {
    render(<MainLayout />);

    fireEvent.click(screen.getByTestId("mock-menu-exit"));

    expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));

    await waitFor(() => {
      expect(exitApp).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps Taomni open and offers a graceful-shutdown retry when cleanup fails", async () => {
    vi.mocked(exitApp)
      .mockRejectedValueOnce("Linux capture teardown failed: Operation not permitted")
      .mockResolvedValueOnce(undefined);
    render(<MainLayout />);

    fireEvent.click(screen.getByTestId("window-close"));
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));

    expect(await screen.findByText("SocksCap cleanup failed")).toBeInTheDocument();
    expect(screen.getByTestId("confirm-dialog-message")).toHaveTextContent(
      "Taomni stayed open because SocksCap could not safely restore the network",
    );
    expect(exitApp).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    await waitFor(() => {
      expect(exitApp).toHaveBeenCalledTimes(2);
    });
  });

  it("opens a local terminal from Ctrl+Shift+T outside the welcome tab", async () => {
    window.localStorage.setItem("taomni.terminalDefaultProfile.v1", JSON.stringify({
      ...DEFAULT_TERMINAL_PROFILE,
      theme: "kanagawa-wave",
    }));
    render(<MainLayout />);

    expect(useAppStore.getState().activeTabId).toBe("ssh-tab");

    fireEvent.keyDown(window, { key: "T", ctrlKey: true, shiftKey: true });

    await waitFor(() => {
      expect(
        useAppStore.getState().tabs.some((tab) => tab.type === "terminal" && tab.id.startsWith("local-")),
      ).toBe(true);
    });
    const localTab = useAppStore.getState().tabs.find((tab) => tab.type === "terminal" && tab.id.startsWith("local-"));
    expect(localTab?.terminalProfile?.theme).toBe("kanagawa-wave");
  });

  it("numbers new local terminal titles from existing terminal tab names", async () => {
    useAppStore.setState({
      tabs: [
        ...useAppStore.getState().tabs,
        { id: "local-base", type: "terminal", title: "Local terminal", closable: true },
        { id: "local-copy", type: "terminal", title: "Local terminal-1", closable: true },
      ],
      activeTabId: "ssh-tab",
    });
    render(<MainLayout />);

    fireEvent.keyDown(window, { key: "T", ctrlKey: true, shiftKey: true });

    await waitFor(() => {
      expect(
        useAppStore.getState().tabs.some((tab) => tab.id.startsWith("local-") && tab.title === "Local terminal-2"),
      ).toBe(true);
    });
  });

  it("opens saved local shell sessions with the MCP requested shell type", async () => {
    const session: SessionConfig = {
      id: "local-shell-1",
      name: "Local Work",
      session_type: "LocalShell",
      group_path: null,
      host: "",
      port: 0,
      username: null,
      auth_method: "None",
      options_json: "{}",
      created_at: 0,
      updated_at: 0,
      last_connected_at: null,
      sort_order: 0,
    };
    useSessionStore.setState({ sessions: [session] });

    render(<MainLayout />);

    await act(async () => {
      await emit("agent-cc-control-tool", {
        callId: "call-local-session",
        threadId: "thread-1",
        tool: "session_open",
        args: {
          session_id: "local-shell-1",
          local_shell: { type: "cmd" },
        },
      });
    });

    await waitFor(() => {
      const tab = useAppStore.getState().tabs.find((item) => item.sessionId === "local-shell-1");
      expect(tab?.type).toBe("terminal");
      expect(tab?.localShell).toEqual({
        id: "command-prompt",
        name: "Command Prompt",
      });
    });
    expect(tauriInvoke).toHaveBeenCalledWith("cc_resolve_tool_call", {
      callId: "call-local-session",
      ok: true,
      output: "opened session local-shell-1",
    });
  });

  it("switches tabs with macOS Command+number shortcuts", async () => {
    const restorePlatform = setNavigatorPlatform("MacIntel");
    const shortcutTabs = [
      { id: "welcome", type: "welcome" as const, title: "Welcome", closable: false },
      ...Array.from({ length: 7 }, (_, index) => ({
        id: `term-${index + 1}`,
        type: "terminal" as const,
        title: `Terminal ${index + 1}`,
        closable: true,
      })),
    ];
    useAppStore.setState({
      tabs: shortcutTabs,
      activeTabId: "term-7",
      terminalSplitActive: false,
    });

    try {
      render(<MainLayout />);

      for (const [index, tab] of shortcutTabs.filter((tab) => tab.type !== "welcome").entries()) {
        const digit = String(index + 1);
        fireEvent.keyDown(window, { key: digit, code: `Digit${digit}`, metaKey: true });
        await waitFor(() => {
          expect(useAppStore.getState().activeTabId).toBe(tab.id);
        });
        if (tab.type === "terminal") {
          const panel = screen
            .getAllByTestId("terminal-panel")
            .find((node) => node.getAttribute("data-tab-id") === tab.id);
          expect(panel).toHaveAttribute("data-active-shortcuts", "true");
        }
      }

      fireEvent.keyDown(window, { key: "9", code: "Digit9", metaKey: true });

      await waitFor(() => {
        expect(useAppStore.getState().activeTabId).toBe("term-7");
      });
    } finally {
      restorePlatform();
    }
  });

  it("keeps Command+number no-op when the target tab is missing", () => {
    const restorePlatform = setNavigatorPlatform("MacIntel");
    useAppStore.setState({
      tabs: [
        { id: "welcome", type: "welcome", title: "Welcome", closable: false },
        { id: "term-1", type: "terminal", title: "One", closable: true },
        { id: "term-2", type: "terminal", title: "Two", closable: true },
      ],
      activeTabId: "term-1",
      terminalSplitActive: false,
    });

    try {
      render(<MainLayout />);

      const event = new KeyboardEvent("keydown", {
        key: "5",
        code: "Digit5",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(event);

      expect(useAppStore.getState().activeTabId).toBe("term-1");
      expect(event.defaultPrevented).toBe(true);
    } finally {
      restorePlatform();
    }
  });

  it("does not treat ordinary digits or non-macOS Meta+digits as tab shortcuts", () => {
    const restorePlatform = setNavigatorPlatform("Win32");
    useAppStore.setState({
      tabs: [
        { id: "welcome", type: "welcome", title: "Welcome", closable: false },
        { id: "term-1", type: "terminal", title: "One", closable: true },
        { id: "term-2", type: "terminal", title: "Two", closable: true },
      ],
      activeTabId: "term-1",
      terminalSplitActive: false,
    });

    try {
      render(<MainLayout />);

      const input = document.createElement("input");
      document.body.appendChild(input);
      const plainDigit = new KeyboardEvent("keydown", {
        key: "2",
        code: "Digit2",
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(plainDigit);
      input.remove();

      expect(useAppStore.getState().activeTabId).toBe("term-1");
      expect(plainDigit.defaultPrevented).toBe(false);

      const metaDigit = new KeyboardEvent("keydown", {
        key: "2",
        code: "Digit2",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(metaDigit);

      expect(useAppStore.getState().activeTabId).toBe("term-1");
      expect(metaDigit.defaultPrevented).toBe(false);
    } finally {
      restorePlatform();
    }
  });

  it("toggles the sidebar from the control bar", () => {
    render(<MainLayout />);

    expect(screen.getByTestId("control-bar")).toBeInTheDocument();
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);

    fireEvent.click(screen.getByTestId("mock-sidebar-toggle"));
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
    expect(terminalLifecycle.mounted).toHaveBeenCalledTimes(1);
    expect(terminalLifecycle.unmounted).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("mock-sidebar-toggle"));
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
  });
}
