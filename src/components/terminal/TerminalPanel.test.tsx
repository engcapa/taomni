import "./tests/terminalPanel/harness";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, vi } from "vitest";
import { useAppStore } from "../../stores/appStore";
import { registerTerminalPanelClipboard3Cases } from "./tests/terminalPanel/clipboard3.cases";
import { registerTerminalPanelClipboard4Cases } from "./tests/terminalPanel/clipboard4.cases";
import { registerTerminalPanelClipboard5Cases } from "./tests/terminalPanel/clipboard5.cases";
import { registerTerminalPanelClipboard6Cases } from "./tests/terminalPanel/clipboard6.cases";
import { registerTerminalPanelClipboard7Cases } from "./tests/terminalPanel/clipboard7.cases";
import { registerTerminalPanelClipboard8Cases } from "./tests/terminalPanel/clipboard8.cases";
import { clipboardMocks, ipcMocks, ResizeObserverMock, sockscapMocks, terminalMocks, webglMocks } from "./tests/terminalPanel/harness";
import { registerTerminalPanelLayout2Cases } from "./tests/terminalPanel/layout2.cases";
import { registerTerminalPanelNavigation1Cases } from "./tests/terminalPanel/navigation1.cases";

registerTerminalPanelNavigation1Cases();

describe("TerminalPanel focus behavior", () => {
  beforeEach(() => {
    window.localStorage.clear();
    terminalMocks.oscHandlers.clear();
    terminalMocks.state.onDataHandler = null;
    terminalMocks.state.onRenderHandler = null;
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
    ipcMocks.createSshTerminal.mockImplementation(async (sessionId: string) => sessionId);
    ipcMocks.listenTerminalExit.mockImplementation(async (sessionId: string, callback: () => void) => {
      ipcMocks.terminalExitHandlers.set(sessionId, callback);
      return vi.fn(() => ipcMocks.terminalExitHandlers.delete(sessionId));
    });
    sockscapMocks.sockscapLaunchTerminalApp.mockClear();
    sockscapMocks.sockscapStopLaunchedApp.mockClear();
    clipboardMocks.readFiles.mockReset();
    clipboardMocks.readFiles.mockResolvedValue([]);
    clipboardMocks.parseFilePaths.mockReset();
    clipboardMocks.parseFilePaths.mockResolvedValue([]);
    webglMocks.instances.length = 0;
    webglMocks.ctor.mockClear();
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });
  registerTerminalPanelClipboard3Cases();
  registerTerminalPanelClipboard4Cases();
  registerTerminalPanelClipboard5Cases();
  registerTerminalPanelClipboard6Cases();
  registerTerminalPanelClipboard7Cases();
  registerTerminalPanelClipboard8Cases();
});

registerTerminalPanelLayout2Cases();
