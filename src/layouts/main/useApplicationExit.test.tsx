import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../../types";
import type { ConfirmDialogOptions } from "../../components/sidebar/ConfirmDialog";
import { useExplorerStore } from "../../stores/explorerStore";
import { useDocumentStore } from "../../stores/documentStore";
import { useApplicationExit } from "./useApplicationExit";

const exitApp = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const windowMocks = { onCloseRequested: vi.fn(() => Promise.resolve(() => undefined)) };

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowMocks,
}));

vi.mock("../../lib/ipc", () => ({
  exitApp,
}));

vi.mock("../../lib/queryRegistry", () => ({
  listQueryTabs: () => [],
}));

vi.mock("../../lib/openFile/closeGuard", () => ({
  confirmViewerExit: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("../../stores/backupSettingsStore", () => ({
  saveBackupSettingsBeforeExit: vi.fn(() => Promise.resolve(true)),
}));

function terminalTab(): Tab {
  return { id: "t1", type: "terminal", title: "shell", closable: true } as unknown as Tab;
}

function browserTab(id: string): Tab {
  return {
    id,
    type: "file-browser",
    title: "folder",
    closable: true,
    fileBrowser: { initialPath: "/preview", explorer: true },
  } as unknown as Tab;
}

function exitProbe(tabs: Tab[], confirmed: boolean) {
  const confirmAppExit = vi.fn((_options: ConfirmDialogOptions) => Promise.resolve(confirmed));
  let exit: (() => void) | undefined;
  function Probe() {
    const app = useApplicationExit({
      tabsRef: { current: tabs },
      confirmAppExit,
      exitRequestInFlightRef: { current: false },
    });
    exit = app.requestAppExit;
    return null;
  }
  render(<Probe />);
  return { confirmAppExit, request: () => exit!() };
}

describe("useApplicationExit open-tab guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useExplorerStore.setState({ tabs: [], activeTabId: null });
    useDocumentStore.setState({ documents: {} });
  });

  it("exits without confirmation when neither surface has closable tabs", async () => {
    const { confirmAppExit, request } = exitProbe([], true);
    await act(async () => { await request(); });
    expect(confirmAppExit).not.toHaveBeenCalled();
    expect(exitApp).toHaveBeenCalled();
  });

  it("confirms once when only a dedicated Explorer tab is open", async () => {
    useExplorerStore.getState().openTab(browserTab("e1"));
    const { confirmAppExit, request } = exitProbe([], false);
    await act(async () => { await request(); });
    expect(confirmAppExit).toHaveBeenCalledTimes(1);
    const options = confirmAppExit.mock.calls[0][0];
    expect(options.title).toBeTruthy();
    expect(exitApp).not.toHaveBeenCalled();
  });

  it("keeps terminal wording when sessions terminals are open beside Explorer tabs", async () => {
    useExplorerStore.getState().openTab(browserTab("e1"));
    const { confirmAppExit, request } = exitProbe([terminalTab()], false);
    await act(async () => { await request(); });
    expect(confirmAppExit).toHaveBeenCalledTimes(1);
    expect(exitApp).not.toHaveBeenCalled();
  });
});
