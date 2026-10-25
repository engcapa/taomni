import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { listSessions, markSessionConnected, writeTerminal, type SessionConfig } from "../../../lib/ipc";
import { DEFAULT_TERMINAL_PROFILE } from "../../../lib/terminalProfile";
import { useAppStore } from "../../../stores/appStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { MainLayout } from "../../MainLayout";
import { controlBarMock, makeSessionWithProfile, sidebarMock, terminalLifecycle } from "./harness";

export function registerMainLayoutLifecycle3Cases() {

  it("collapses the main sidebar to a fixed rail without leaving the panel gap", () => {
    useAppStore.setState({
      sidebarCollapsed: true,
    });

    render(<MainLayout />);

    expect(screen.getByTestId("collapsed-sidebar-rail")).toBeInTheDocument();
    expect(screen.getByTestId("main-sidebar-resize-handle")).toHaveStyle({
      width: "0px",
      visibility: "hidden",
      pointerEvents: "none",
    });
  });

  it("shows all terminal panes in split mode and switches layouts without remounting terminals", async () => {
    useAppStore.setState({
      tabs: [
        { id: "welcome", type: "welcome", title: "Welcome", closable: false },
        { id: "term-1", type: "terminal", title: "One", closable: true },
        { id: "term-2", type: "terminal", title: "Two", closable: true },
      ],
      activeTabId: "term-1",
      terminalSplitActive: true,
      terminalSplitLayout: "horizontal",
      terminalSplitInputLockedTabIds: new Set(),
    });

    render(<MainLayout />);

    const panels = screen.getAllByTestId("terminal-panel");
    expect(panels).toHaveLength(2);
    expect(panels.map((panel) => panel.getAttribute("data-visible"))).toEqual(["true", "true"]);
    expect(panels[0]).toHaveAttribute("data-active-shortcuts", "true");
    expect(panels[1]).toHaveAttribute("data-active-shortcuts", "false");
    expect(screen.getByTestId("terminal-split-panes")).toHaveAttribute("data-layout", "horizontal");
    expect(terminalLifecycle.mounted).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByTestId("terminal-split-layout-grid"));

    await waitFor(() => {
      expect(screen.getByTestId("terminal-split-panes")).toHaveAttribute("data-layout", "grid");
    });
    expect(terminalLifecycle.mounted).toHaveBeenCalledTimes(2);
    expect(terminalLifecycle.unmounted).not.toHaveBeenCalled();
  });

  it("resizes adjacent terminal panes in horizontal split mode", async () => {
    useAppStore.setState({
      tabs: [
        { id: "welcome", type: "welcome", title: "Welcome", closable: false },
        { id: "term-1", type: "terminal", title: "One", closable: true },
        { id: "term-2", type: "terminal", title: "Two", closable: true },
      ],
      activeTabId: "term-1",
      terminalSplitActive: true,
      terminalSplitLayout: "horizontal",
      terminalSplitInputLockedTabIds: new Set(),
    });

    render(<MainLayout />);

    const panesContainer = screen.getByTestId("terminal-split-panes");
    Object.defineProperty(panesContainer, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 0, right: 1000, bottom: 500, width: 1000, height: 500 }),
    });

    const handle = screen.getByTestId("terminal-split-resize-handle");
    fireEvent.pointerDown(handle, { clientX: 500, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 700, clientY: 0 });
    fireEvent.pointerUp(window);

    const panes = screen.getAllByTestId("terminal-split-pane");
    await waitFor(() => {
      expect(Number.parseFloat((panes[0] as HTMLElement).style.flexGrow)).toBeCloseTo(1.4);
      expect(Number.parseFloat((panes[1] as HTMLElement).style.flexGrow)).toBeCloseTo(0.6);
    });
    expect(terminalLifecycle.mounted).toHaveBeenCalledTimes(2);
    expect(terminalLifecycle.unmounted).not.toHaveBeenCalled();
  });

  it("resizes grid split columns and rows", async () => {
    useAppStore.setState({
      tabs: [
        { id: "welcome", type: "welcome", title: "Welcome", closable: false },
        { id: "term-1", type: "terminal", title: "One", closable: true },
        { id: "term-2", type: "terminal", title: "Two", closable: true },
        { id: "term-3", type: "terminal", title: "Three", closable: true },
        { id: "term-4", type: "terminal", title: "Four", closable: true },
      ],
      activeTabId: "term-1",
      terminalSplitActive: true,
      terminalSplitLayout: "grid",
      terminalSplitInputLockedTabIds: new Set(),
    });

    render(<MainLayout />);

    const panesContainer = screen.getByTestId("terminal-split-panes");
    Object.defineProperty(panesContainer, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }),
    });

    fireEvent.pointerDown(screen.getByTestId("terminal-split-grid-column-resize-handle"), {
      clientX: 500,
      clientY: 0,
    });
    fireEvent.pointerMove(window, { clientX: 650, clientY: 0 });
    fireEvent.pointerUp(window);

    await waitFor(() => {
      expect((panesContainer as HTMLElement).style.gridTemplateColumns).toContain("1.3fr");
      expect((panesContainer as HTMLElement).style.gridTemplateColumns).toContain("0.7fr");
    });

    fireEvent.pointerDown(screen.getByTestId("terminal-split-grid-row-resize-handle"), {
      clientX: 0,
      clientY: 300,
    });
    fireEvent.pointerMove(window, { clientX: 0, clientY: 420 });
    fireEvent.pointerUp(window);

    await waitFor(() => {
      expect((panesContainer as HTMLElement).style.gridTemplateRows).toContain("1.4fr");
      expect((panesContainer as HTMLElement).style.gridTemplateRows).toContain("0.6fr");
    });
  });

  it("updates the active terminal from a split pane click and passes input lock state", async () => {
    useAppStore.setState({
      tabs: [
        { id: "welcome", type: "welcome", title: "Welcome", closable: false },
        { id: "term-1", type: "terminal", title: "One", closable: true },
        { id: "term-2", type: "terminal", title: "Two", closable: true },
      ],
      activeTabId: "term-1",
      terminalSplitActive: true,
      terminalSplitLayout: "horizontal",
      terminalSplitInputLockedTabIds: new Set(),
    });

    render(<MainLayout />);

    const paneTwo = screen
      .getAllByTestId("terminal-split-pane")
      .find((pane) => pane.getAttribute("data-tab-id") === "term-2");
    expect(paneTwo).toBeTruthy();

    fireEvent.mouseDown(paneTwo!);

    await waitFor(() => {
      expect(useAppStore.getState().activeTabId).toBe("term-2");
      expect(paneTwo).toHaveAttribute("data-active", "true");
    });

    fireEvent.click(screen.getByTestId("terminal-split-lock-term-2"));

    await waitFor(() => {
      expect(paneTwo).toHaveAttribute("data-input-locked", "true");
      expect(
        screen
          .getAllByTestId("terminal-panel")
          .find((panel) => panel.getAttribute("data-tab-id") === "term-2"),
      ).toHaveAttribute("data-input-locked", "true");
    });
  });

  it("skips split-locked selected terminals when MultiExec broadcasts", async () => {
    useAppStore.setState({
      tabs: [
        { id: "welcome", type: "welcome", title: "Welcome", closable: false },
        { id: "term-1", type: "terminal", title: "One", closable: true },
        { id: "term-2", type: "terminal", title: "Two", closable: true },
      ],
      activeTabId: "term-1",
      terminalSplitActive: true,
      terminalSplitLayout: "horizontal",
      terminalSplitInputLockedTabIds: new Set(["term-2"]),
      multiExecActive: true,
      multiExecSelectedTabIds: new Set(["term-1", "term-2"]),
    });
    vi.mocked(writeTerminal).mockClear();

    render(<MainLayout />);

    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    const input = screen.getByTestId("multiexec-input");
    fireEvent.change(input, { target: { value: "date" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(writeTerminal).toHaveBeenCalledWith("session-term-1", btoa("date\r"));
    });
    expect(writeTerminal).not.toHaveBeenCalledWith("session-term-2", btoa("date\r"));
  });

  it("passes edited session terminal profiles to already-open terminal tabs", async () => {
    const initialSession = makeSessionWithProfile({
      ...DEFAULT_TERMINAL_PROFILE,
      fontSize: 13,
      theme: "classic",
    });
    const updatedSession = makeSessionWithProfile({
      ...DEFAULT_TERMINAL_PROFILE,
      fontSize: 19,
      theme: "termius-dark",
    });
    vi.mocked(listSessions).mockResolvedValue([initialSession]);
    useSessionStore.setState({ sessions: [initialSession], groups: [] });
    useAppStore.setState({
      tabs: [
        { id: "welcome", type: "welcome", title: "Welcome", closable: false },
        {
          id: "ssh-tab",
          type: "terminal",
          title: "root@example.test",
          sessionId: initialSession.id,
          closable: true,
          ssh: {
            sessionId: initialSession.id,
            host: "example.test",
            port: 22,
            username: "root",
            authMethod: "Password",
            authData: "secret",
            optionsJson: initialSession.options_json,
          },
          terminalProfile: {
            ...DEFAULT_TERMINAL_PROFILE,
            fontSize: 11,
            theme: "classic",
          },
        },
      ],
      activeTabId: "ssh-tab",
      sidebarCollapsed: false,
      statusMessage: "Ready",
    });

    render(<MainLayout />);

    expect(screen.getByTestId("terminal-panel")).toHaveAttribute("data-terminal-font-size", "13");
    expect(screen.getByTestId("terminal-panel")).toHaveAttribute("data-terminal-theme", "classic");

    act(() => {
      useSessionStore.setState({ sessions: [updatedSession] });
    });

    await waitFor(() => {
      expect(screen.getByTestId("terminal-panel")).toHaveAttribute("data-terminal-font-size", "19");
      expect(screen.getByTestId("terminal-panel")).toHaveAttribute("data-terminal-theme", "termius-dark");
    });
  });

  it("applies runtime terminal profile changes from an open terminal tab", async () => {
    useAppStore.setState({
      tabs: [
        { id: "welcome", type: "welcome", title: "Welcome", closable: false },
        {
          id: "ssh-tab",
          type: "terminal",
          title: "root@example.test",
          ssh: {
            host: "example.test",
            port: 22,
            username: "root",
            authMethod: "Password",
            authData: "secret",
            optionsJson: undefined,
          },
          closable: true,
          terminalProfile: {
            ...DEFAULT_TERMINAL_PROFILE,
            fontSize: 14,
            theme: "classic",
          },
        },
      ],
      activeTabId: "ssh-tab",
      sidebarCollapsed: false,
      statusMessage: "Ready",
    });

    render(<MainLayout />);

    expect(screen.getByTestId("terminal-panel")).toHaveAttribute("data-terminal-font-size", "14");
    expect(screen.getByTestId("terminal-panel")).toHaveAttribute("data-terminal-theme", "classic");

    fireEvent.click(screen.getByTestId("mock-terminal-profile-change-ssh-tab"));

    await waitFor(() => {
      expect(screen.getByTestId("terminal-panel")).toHaveAttribute("data-terminal-font-size", "21");
      expect(screen.getByTestId("terminal-panel")).toHaveAttribute("data-terminal-theme", "kanagawa-wave");
    });
  });

  it("duplicates terminal tabs with the current runtime terminal profile", async () => {
    useAppStore.setState({
      tabs: [
        { id: "welcome", type: "welcome", title: "Welcome", closable: false },
        {
          id: "ssh-tab",
          type: "terminal",
          title: "root@example.test",
          ssh: {
            host: "example.test",
            port: 22,
            username: "root",
            authMethod: "Password",
            authData: "secret",
            optionsJson: undefined,
          },
          closable: true,
          terminalProfile: {
            ...DEFAULT_TERMINAL_PROFILE,
            fontSize: 14,
            theme: "classic",
          },
        },
      ],
      activeTabId: "ssh-tab",
      sidebarCollapsed: false,
      statusMessage: "Ready",
    });

    render(<MainLayout />);

    fireEvent.click(screen.getByTestId("mock-terminal-profile-change-ssh-tab"));
    await waitFor(() => {
      expect(screen.getByTestId("terminal-panel")).toHaveAttribute("data-terminal-font-size", "21");
    });

    await act(async () => {
      controlBarMock.props.at(-1)?.onDuplicateTab?.("ssh-tab");
    });

    await waitFor(() => {
      const copy = useAppStore.getState().tabs.find((tab) => tab.id !== "ssh-tab" && tab.title === "root@example.test-1");
      expect(copy?.terminalProfile).toMatchObject({
        fontSize: 21,
        theme: "kanagawa-wave",
      });
    });
  });

  it("duplicates temporary local terminals with the saved terminal default profile when no live profile exists", async () => {
    window.localStorage.setItem("taomni.terminalDefaultProfile.v1", JSON.stringify({
      ...DEFAULT_TERMINAL_PROFILE,
      theme: "termius-dark",
      fontSize: 18,
    }));
    useAppStore.setState({
      tabs: [
        { id: "welcome", type: "welcome", title: "Welcome", closable: false },
        {
          id: "local-tab",
          type: "terminal",
          title: "Local",
          closable: true,
          localShell: { id: "command-prompt", name: "Command Prompt" },
        },
      ],
      activeTabId: "local-tab",
      sidebarCollapsed: false,
      statusMessage: "Ready",
    });

    render(<MainLayout />);

    await act(async () => {
      controlBarMock.props.at(-1)?.onDuplicateTab?.("local-tab");
    });

    await waitFor(() => {
      const copy = useAppStore.getState().tabs.find((tab) => tab.id !== "local-tab" && tab.title === "Local-1");
      expect(copy?.terminalProfile).toMatchObject({
        fontSize: 18,
        theme: "termius-dark",
      });
    });
  });

  it("opens Browser saved sessions with the system browser", async () => {
    render(<MainLayout />);

    const browserSession: SessionConfig = {
      id: "browser-1",
      name: "Docs",
      session_type: "Browser",
      group_path: null,
      host: "docs.example.test",
      port: 8443,
      username: null,
      auth_method: "None",
      options_json: "{}",
      created_at: 0,
      updated_at: 0,
      last_connected_at: null,
      sort_order: 0,
    };
    useSessionStore.setState({ sessions: [browserSession], groups: [] });

    await act(async () => {
      sidebarMock.props.at(-1)?.onConnectSession?.(browserSession);
    });

    await waitFor(() => {
      expect(tauriInvoke).toHaveBeenCalledWith("open_external_url", {
        url: "https://docs.example.test:8443",
      });
    });
    await waitFor(() => expect(markSessionConnected).toHaveBeenCalledWith("browser-1"));
    expect(useAppStore.getState().tabs.some((tab) => tab.type === "placeholder")).toBe(false);
  });

  it("opens saved SSH sessions without a profile using the terminal default profile", async () => {
    window.localStorage.setItem("taomni.terminalDefaultProfile.v1", JSON.stringify({
      ...DEFAULT_TERMINAL_PROFILE,
      fontSize: 18,
      theme: "kanagawa-wave",
    }));
    render(<MainLayout />);

    const session: SessionConfig = {
      id: "ssh-default-profile",
      name: "Default SSH",
      session_type: "SSH",
      group_path: null,
      host: "ssh-default.example.test",
      port: 22,
      username: "root",
      auth_method: "Agent",
      options_json: "{}",
      created_at: 0,
      updated_at: 0,
      last_connected_at: null,
      sort_order: 0,
    };
    useSessionStore.setState({ sessions: [session], groups: [] });

    await act(async () => {
      sidebarMock.props.at(-1)?.onConnectSession?.(session);
    });

    await waitFor(() => {
      const tab = useAppStore.getState().tabs.find((item) => item.sessionId === "ssh-default-profile");
      expect(tab?.terminalProfile).toMatchObject({
        fontSize: 18,
        theme: "kanagawa-wave",
      });
      expect(tab?.terminalTitleSessionName).toBe("Default SSH");
    });
  });
}
