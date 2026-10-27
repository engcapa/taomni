import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitWelcomeRunSnapshot, getWelcomeRunSnapshot, listSessions, type SessionConfig } from "../../../lib/ipc";
import { savedSessionEntry } from "../../../lib/welcomeSessionResume";
import { useAppStore } from "../../../stores/appStore";
import { useMainRailHostStore } from "../../../stores/mainRailHostStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { MainLayout } from "../../MainLayout";
import { panelResizeMock, sidebarMock, terminalPanelMock } from "./harness";

export function registerMainLayoutLayout1Cases() {

  describe("MainLayout ED-PARITY-027 single tool window bar", () => {
    let host: HTMLDivElement;
    beforeEach(() => {
      window.localStorage.clear();
      terminalPanelMock.props = [];
      sidebarMock.props = [];
      vi.mocked(listSessions).mockResolvedValue([]);
      host = document.createElement("div");
      host.setAttribute("data-testid", "rail-host-under-test");
      document.body.appendChild(host);
      useMainRailHostStore.setState({ host });
      useAppStore.setState({
        tabs: [
          { id: "welcome", type: "welcome", title: "Welcome", closable: false },
          {
            id: "ssh-tab",
            type: "terminal",
            title: "root@example.test",
            closable: true,
            ssh: { host: "example.test", port: 22, username: "root", authMethod: "Password", authData: "secret", optionsJson: undefined },
          },
        ],
        activeTabId: "welcome",
        activeSideTab: "sessions",
        sidebarCollapsed: false,
        mergeToolWindowRail: true,
        sidebarCollapsedByGroup: { "code-workspace": true, terminal: true, other: false },
        terminalSplitActive: false,
        multiExecActive: false,
        multiExecSelectedTabIds: new Set(),
      });
    });

    afterEach(() => {
      cleanup();
      host.remove();
      useMainRailHostStore.setState({ host: null });
    });

    it("restores terminal collapse preferences while Home remains full width", async () => {
      render(<MainLayout />);
      expect(useAppStore.getState().sidebarCollapsed).toBe(false);
      act(() => useAppStore.getState().setActiveTab("ssh-tab"));
      await waitFor(() => expect(useAppStore.getState().sidebarCollapsed).toBe(true));
      act(() => useAppStore.getState().setActiveTab("welcome"));
      await waitFor(() => expect(useAppStore.getState().sidebarCollapsed).toBe(true));
      expect(useAppStore.getState().sidebarCollapsedByGroup.other).toBe(false);
    });

    it("keeps the store's state over a restored collapsed layout and syncs later drags", async () => {
      render(<MainLayout />);
      const onResize = panelResizeMock.handlers.get("sidebar");
      expect(onResize).toBeDefined();
      // First report = the restored layout of a session that quit in a terminal.
      act(() => onResize?.({ asPercentage: 0, inPixels: 0 }, "sidebar", undefined));
      expect(useAppStore.getState().sidebarCollapsed).toBe(false);
      expect(useAppStore.getState().sidebarCollapsedByGroup.other).toBe(false);
      expect(window.localStorage.getItem("taomni.sidebarCollapsed")).toBeNull();
      // A later report is a drag on the divider: a manual change for the empty Sessions canvas.
      act(() => onResize?.({ asPercentage: 0, inPixels: 0 }, "sidebar", { asPercentage: 22, inPixels: 220 }));
      expect(useAppStore.getState().sidebarCollapsed).toBe(true);
      expect(useAppStore.getState().sidebarCollapsedByGroup.other).toBe(true);
      expect(window.localStorage.getItem("taomni.sidebarCollapsed")).toBe("true");
    });

    it("keeps the terminal preference when a programmatic Home return expands the panel", () => {
      render(<MainLayout />);
      act(() => useAppStore.getState().setActiveTab("ssh-tab"));
      act(() => useAppStore.getState().setActiveSideTab("home"));
      act(() => useAppStore.getState().setActiveSideTab("sessions"));
      const onResize = panelResizeMock.handlers.get("sidebar");
      act(() => onResize?.({ asPercentage: 22, inPixels: 220 }, "sidebar", { asPercentage: 0, inPixels: 0 }));
      expect(useAppStore.getState().sidebarCollapsed).toBe(false);
      expect(useAppStore.getState().sidebarCollapsedByGroup.terminal).toBe(true);
      act(() => useAppStore.getState().setActiveTab("ssh-tab"));
      expect(useAppStore.getState().sidebarCollapsed).toBe(true);
    });

    it("applies navigator geometry before the next frame can receive a tab click", () => {
      // Returning from Home must not expose the old canvas position while a
      // later RAF moves the title bar underneath an in-progress native click.
      const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
      panelResizeMock.commands = [];
      try {
        useAppStore.setState({ activeTabId: "ssh-tab", mergeToolWindowRail: false });
        render(<MainLayout />);
        expect(panelResizeMock.commands.at(-1)).toEqual({ id: "sidebar", size: "260px" });
        const onResize = panelResizeMock.handlers.get("sidebar");
        act(() => onResize?.({ asPercentage: 27, inPixels: 270 }, "sidebar", undefined));
        act(() => useAppStore.getState().setActiveSideTab("home"));
        expect(panelResizeMock.commands.at(-1)).toEqual({ id: "sidebar", size: null });
        act(() => useAppStore.getState().setActiveSideTab("sessions"));
        expect(panelResizeMock.commands.at(-1)).toEqual({ id: "sidebar", size: "27%" });
        expect(useAppStore.getState().sidebarCollapsedByGroup.terminal).toBe(true);
      } finally {
        frame.mockRestore();
      }
    });

    it("remembers a manual expand for terminal tabs only", async () => {
      render(<MainLayout />);
      act(() => useAppStore.getState().setActiveTab("ssh-tab"));
      await waitFor(() => expect(useAppStore.getState().sidebarCollapsed).toBe(true));
      act(() => useAppStore.getState().toggleSidebar());
      expect(useAppStore.getState().sidebarCollapsedByGroup.terminal).toBe(false);
      act(() => useAppStore.getState().setActiveTab("welcome"));
      act(() => useAppStore.getState().setActiveTab("ssh-tab"));
      await waitFor(() => expect(useAppStore.getState().sidebarCollapsed).toBe(false));
      expect(useAppStore.getState().sidebarCollapsedByGroup["code-workspace"]).toBe(true);
    });

    it("moves SFTP into the collapsed rail and leaves Chat to the shared bottom button", async () => {
      render(<MainLayout />);
      act(() => useAppStore.getState().setActiveTab("ssh-tab"));
      await waitFor(() => expect(host.querySelector('[data-testid="attached-sftp-toggle"]')).not.toBeNull());
      expect(host.querySelector('[data-testid="tab-chat-toggle"]')).toBeNull();
      const active = terminalPanelMock.props.filter((props) => props.tabId === "ssh-tab").at(-1);
      expect(active?.sftpToggle).toBeUndefined();
      expect(active?.chatToggle).toBeUndefined();
      fireEvent.click(host.querySelector('[data-testid="attached-sftp-toggle"]')!);
      expect(screen.getByTestId("sftp-sidebar")).toBeInTheDocument();
      expect(host.querySelector('[data-testid="attached-sftp-toggle"]')).toHaveAttribute("aria-pressed", "true");
    });

    it("keeps the floating toggles when the bar merge is turned off", async () => {
      useAppStore.setState({ mergeToolWindowRail: false });
      render(<MainLayout />);
      act(() => useAppStore.getState().setActiveTab("ssh-tab"));
      expect(useAppStore.getState().sidebarCollapsed).toBe(false);
      expect(host.querySelector('[data-testid="attached-sftp-toggle"]')).toBeNull();
      const active = terminalPanelMock.props.filter((props) => props.tabId === "ssh-tab").at(-1);
      expect(active?.sftpToggle).toBeDefined();
    });
  });

  describe("MainLayout run-snapshot collector (V-06)", () => {
    let originalPlatform: string;
    let originalUserAgent: string;

    beforeEach(() => {
      originalPlatform = window.navigator.platform;
      originalUserAgent = window.navigator.userAgent;
      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: "Linux x86_64",
      });
      Object.defineProperty(window.navigator, "userAgent", {
        configurable: true,
        value: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
      });
      window.localStorage.clear();
      useSessionStore.setState({
        sessions: [],
        groups: [],
        loading: false,
        selectedSessionId: null,
        selectedSessionIds: [],
        searchQuery: "",
      });
      useAppStore.setState({
        tabs: [{ id: "welcome", type: "welcome", title: "Welcome", closable: false }],
        activeTabId: "welcome",
      });
      (commitWelcomeRunSnapshot as ReturnType<typeof vi.fn>).mockClear();
      vi.mocked(getWelcomeRunSnapshot).mockResolvedValue({ record: null, legacyCandidate: null, issue: null });
      (commitWelcomeRunSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
        record: { schemaVersion: 1, revision: 1, runSequence: 1, batchId: "b", committedAtMs: 1, entries: [], activeIdentity: null },
        applied: true,
      });
      render(<MainLayout />);
    });

    afterEach(() => {
      cleanup();
      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: originalPlatform,
      });
      Object.defineProperty(window.navigator, "userAgent", {
        configurable: true,
        value: originalUserAgent,
      });
      vi.clearAllMocks();
    });

    const sshSession: SessionConfig = {
      id: "sess-1",
      name: "prod",
      session_type: "SSH",
      group_path: null,
      host: "example.test",
      port: 22,
      username: "root",
      auth_method: "Password",
      options_json: "{}",
      created_at: 0,
      updated_at: 0,
      last_connected_at: null,
      sort_order: 0,
    };

    it("commits an ordered snapshot for eligible saved-session tabs", async () => {
      useSessionStore.setState({ sessions: [sshSession] });
      await act(async () => {
        useAppStore.setState({
          tabs: [
            { id: "welcome", type: "welcome", title: "Welcome", closable: false },
            {
              id: "ssh-tab-1",
              type: "terminal",
              title: "prod",
              sessionId: "sess-1",
              closable: true,
            },
          ],
          activeTabId: "ssh-tab-1",
        });
      });

      await waitFor(
        () => expect(commitWelcomeRunSnapshot).toHaveBeenCalled(),
        { timeout: 4000 },
      );
      const payload = (commitWelcomeRunSnapshot as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
      expect(payload.entries).toHaveLength(1);
      expect(payload.entries[0]).toMatchObject({
        kind: "saved-session",
        savedSessionId: "sess-1",
        savedSessionType: "SSH",
      });
      expect(payload.activeIdentity).toBe("saved:sess-1");
    });

    it("never writes an empty snapshot when only Welcome is open", async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(commitWelcomeRunSnapshot).not.toHaveBeenCalled();
    });

    it("refreshes the saved run when Home opens while retaining the active session", async () => {
      await act(async () => {
        useAppStore.setState({
          tabs: [
            { id: "welcome", type: "welcome", title: "Welcome", closable: false },
            { id: "saved-local", type: "terminal", title: "prod", sessionId: sshSession.id, closable: true },
          ],
          activeTabId: "saved-local",
          activeSideTab: "sessions",
        });
      });
      vi.mocked(getWelcomeRunSnapshot).mockResolvedValue({
        record: { schemaVersion: 1, revision: 2, runSequence: 1, batchId: "home-refresh", committedAtMs: 1, entries: [savedSessionEntry(sshSession)], activeIdentity: "saved:sess-1" },
        legacyCandidate: null,
        issue: null,
      });
      act(() => useAppStore.getState().setActiveSideTab("home"));
      await waitFor(() => expect(screen.getByTestId("welcome-restore-status")).toHaveAttribute("data-state", "available"));
      expect(useAppStore.getState().activeTabId).toBe("saved-local");
      vi.mocked(getWelcomeRunSnapshot).mockResolvedValue({ record: null, legacyCandidate: null, issue: null });
    });

    it("keeps whitelist local terminals with a confirmed cwd in the snapshot", async () => {
      await act(async () => {
        useAppStore.setState({
          tabs: [
            { id: "welcome", type: "welcome", title: "Welcome", closable: false },
            {
              id: "local-1",
              type: "terminal",
              title: "bash",
              closable: true,
              localShell: { id: "/bin/bash", name: "bash" },
            },
          ],
          activeTabId: "local-1",
        });
      });
      // The confirmed cwd arrives through the terminal's OSC reporting.
      await waitFor(() => {
        const props = terminalPanelMock.props.find((candidate) => candidate.tabId === "local-1");
        expect(props?.onCwdChange).toBeTruthy();
      });
      await act(async () => {
        terminalPanelMock.props
          .filter((candidate) => candidate.tabId === "local-1")
          .at(-1)
          ?.onCwdChange?.("/work/repo");
      });
      await waitFor(
        () => expect(commitWelcomeRunSnapshot).toHaveBeenCalled(),
        { timeout: 4000 },
      );
      const payload = (commitWelcomeRunSnapshot as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
      const local = payload.entries.find(
        (entry: { kind: string; }) => entry.kind === "local-terminal",
      );
      expect(local).toMatchObject({
        shellId: "/bin/bash",
        confirmedCwd: "/work/repo",
      });
    });
  });
}
