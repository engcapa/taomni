import "./tests/mainLayout/harness";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, vi } from "vitest";
import { exitApp, listSessions, markSessionConnected } from "../lib/ipc";
import { useAppStore } from "../stores/appStore";
import { useMainRailHostStore } from "../stores/mainRailHostStore";
import { useSessionStore } from "../stores/sessionStore";
import {
  controlBarMock,
  dbClientMock,
  hbaseShellMock,
  quickConnectMock,
  sftpSidebarMock,
  sidebarMock,
  terminalLifecycle,
  terminalPanelMock,
  vaultMock,
} from "./tests/mainLayout/harness";
import { registerMainLayoutLayout1Cases } from "./tests/mainLayout/layout1.cases";
import { registerMainLayoutLifecycle2Cases } from "./tests/mainLayout/lifecycle2.cases";
import { registerMainLayoutLifecycle3Cases } from "./tests/mainLayout/lifecycle3.cases";
import { registerMainLayoutLifecycle4Cases } from "./tests/mainLayout/lifecycle4.cases";

describe("MainLayout attached SFTP sidebar", () => {
  beforeEach(() => {
    window.localStorage.clear();
    terminalLifecycle.mounted.mockClear();
    terminalLifecycle.unmounted.mockClear();
    terminalPanelMock.props = [];
    sidebarMock.props = [];
    quickConnectMock.props = [];
    controlBarMock.props = [];
    dbClientMock.props = [];
    hbaseShellMock.props = [];
    sftpSidebarMock.props = [];
    vaultMock.state = "empty";
    vaultMock.refresh.mockClear();
    vaultMock.unlock.mockClear();
    vi.mocked(exitApp).mockReset();
    vi.mocked(exitApp).mockResolvedValue(undefined);
    vi.mocked(markSessionConnected).mockClear();
    vi.mocked(tauriInvoke).mockClear();
    vi.mocked(listSessions).mockResolvedValue([]);
    useSessionStore.setState({
      sessions: [],
      groups: [],
      loading: false,
      selectedSessionId: null,
      searchQuery: "",
    });
    useAppStore.setState({
      tabs: [
        { id: "welcome", type: "welcome", title: "Welcome", closable: false },
        {
          id: "ssh-tab",
          type: "terminal",
          title: "root@example.test",
          closable: true,
          ssh: {
            host: "example.test",
            port: 22,
            username: "root",
            authMethod: "Password",
            authData: "secret",
            optionsJson: undefined,
          },
        },
      ],
      activeTabId: "ssh-tab",
      sidebarCollapsed: false,
      // These cases cover the legacy layout; ED-PARITY-027 has its own block.
      mergeToolWindowRail: false,
      sidebarCollapsedByGroup: { "code-workspace": true, terminal: true, other: false },
      terminalSplitActive: false,
      terminalSplitLayout: "horizontal",
      terminalSplitInputLockedTabIds: new Set(),
      multiExecActive: false,
      multiExecSelectedTabIds: new Set(),
      statusMessage: "Ready",
    });
    useMainRailHostStore.setState({ host: null });
  });

  afterEach(() => {
    cleanup();
  });
  registerMainLayoutLifecycle2Cases();
  registerMainLayoutLifecycle3Cases();
  registerMainLayoutLifecycle4Cases();
});

registerMainLayoutLayout1Cases();
