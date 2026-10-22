import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../../../stores/appStore";
import { TerminalPanel } from "../../TerminalPanel";
import { ipcMocks, ResizeObserverMock, sshInfo, terminalMocks } from "./harness";

export function registerTerminalPanelLayout2Cases() {

  describe("TerminalPanel local directory confirmed-use reporting (V-03)", () => {
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
      terminalMocks.oscHandlers.clear();
      terminalMocks.state.onDataHandler = null;
      terminalMocks.state.onResizeHandler = null;
      terminalMocks.state.customKeyEventHandler = null;
      ipcMocks.terminalExitHandlers.clear();
      useAppStore.setState({ terminalRuntimeByTab: {}, cwdByTab: {} });
      ipcMocks.createTerminalSessionId.mockImplementation(() => "terminal-session");
      ipcMocks.createLocalTerminal.mockImplementation(async (sessionId: string) => ({
        sessionId,
        shellId: "default",
      }));
      ipcMocks.recordLocalDirectoryUse.mockClear();
      vi.stubGlobal("ResizeObserver", ResizeObserverMock);
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        return window.setTimeout(() => callback(performance.now()), 0);
      });
      vi.stubGlobal("cancelAnimationFrame", (id: number) => {
        window.clearTimeout(id);
      });
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
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    });

    it("records confirmed local cwd changes A->B->A through the structured IPC", async () => {
      render(<TerminalPanel tabId="local-cwd" visible />);

      await waitFor(() => {
        expect(ipcMocks.createLocalTerminal).toHaveBeenCalled();
      });
      expect(ipcMocks.recordLocalDirectoryUse).not.toHaveBeenCalled();

      // Initial cwd report for the spawn path, then a change, then back.
      terminalMocks.oscHandlers.get(7)?.("file://localhost/repo");
      await waitFor(() => {
        expect(ipcMocks.recordLocalDirectoryUse).toHaveBeenCalledWith({
          backendSessionId: "terminal-session",
          path: "/repo",
        });
      });

      terminalMocks.oscHandlers.get(7)?.("file://localhost/workspace");
      await waitFor(() => {
        expect(ipcMocks.recordLocalDirectoryUse).toHaveBeenCalledTimes(2);
      });
      expect((ipcMocks.recordLocalDirectoryUse.mock.calls[1] as unknown[] | undefined)?.[0]).toEqual({
        backendSessionId: "terminal-session",
        path: "/workspace",
      });

      terminalMocks.oscHandlers.get(7)?.("file://localhost/repo");
      await waitFor(() => {
        expect(ipcMocks.recordLocalDirectoryUse).toHaveBeenCalledTimes(3);
      });
      expect((ipcMocks.recordLocalDirectoryUse.mock.calls[2] as unknown[] | undefined)?.[0]).toEqual({
        backendSessionId: "terminal-session",
        path: "/repo",
      });
    });

    it("does not re-record repeated cwd reports for the same directory", async () => {
      render(<TerminalPanel tabId="local-dedup" visible />);

      await waitFor(() => {
        expect(ipcMocks.createLocalTerminal).toHaveBeenCalled();
      });
      terminalMocks.oscHandlers.get(7)?.("file://localhost/repo");
      await waitFor(() => {
        expect(ipcMocks.recordLocalDirectoryUse).toHaveBeenCalledTimes(1);
      });
      // Duplicate prompts/probes for the same path never rewrite the record.
      terminalMocks.oscHandlers.get(7)?.("file://localhost/repo");
      terminalMocks.oscHandlers.get(7)?.("file://localhost/repo");
      expect(ipcMocks.recordLocalDirectoryUse).toHaveBeenCalledTimes(1);
    });

    it("never records SSH remote cwd through the local directory channel", async () => {
      render(<TerminalPanel tabId="ssh-cwd" visible ssh={sshInfo} />);

      await waitFor(() => {
        expect(ipcMocks.createSshTerminal).toHaveBeenCalled();
      });
      terminalMocks.oscHandlers.get(7)?.("file://example.test/home/user/project");
      expect(ipcMocks.recordLocalDirectoryUse).not.toHaveBeenCalled();
    });

    it("surfaces a directory-use save warning without failing the launch", async () => {
      ipcMocks.createLocalTerminal.mockImplementation(async (sessionId: string) => ({
        sessionId,
        shellId: "default",
        directoryUseWarning: "Terminal opened; saving the recent-directories record failed",
      }));
      render(<TerminalPanel tabId="local-warn" visible />);

      await waitFor(() => {
        expect(ipcMocks.createLocalTerminal).toHaveBeenCalled();
      });
      // Launch success stands; the warning is only logged.
      expect(
        useAppStore.getState().terminalRuntimeByTab["local-warn"]?.backendSessionId,
      ).toBe("terminal-session");
    });

    it("reports launch failure through onSessionLaunchFailed", async () => {
      const onSessionLaunchFailed = vi.fn();
      ipcMocks.createLocalTerminal.mockImplementation(async () => {
        throw new Error("pty spawn failed");
      });
      render(
        <TerminalPanel tabId="local-fail" visible onSessionLaunchFailed={onSessionLaunchFailed} />,
      );

      await waitFor(() => {
        expect(onSessionLaunchFailed).toHaveBeenCalled();
      });
      expect(String(onSessionLaunchFailed.mock.calls[0]?.[0])).toContain("pty spawn failed");
    });
  });
}
