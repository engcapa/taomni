import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "../../stores/sessionStore";
import type { SessionConfig, SessionGroup } from "../../lib/ipc";
import { SessionTree } from "./SessionTree";
import { resetSystemFontCacheForTests } from "../../lib/systemFonts";

const ipcMocks = vi.hoisted(() => ({
  deleteSession: vi.fn<(id: string) => Promise<void>>(async () => undefined),
  deleteSessionGroup: vi.fn(async () => undefined),
  importExternalBashSessions: vi.fn(async () => []),
  importPuttySessions: vi.fn(async () => []),
  importWslSessions: vi.fn(async () => []),
  isVaultLockedError: vi.fn(() => false),
  keychainLookupBatch: vi.fn(async () => []),
  listSystemFonts: vi.fn(async () => ["monospace", "JetBrains Mono"]),
  listSessionGroups: vi.fn<() => Promise<SessionGroup[]>>(async () => []),
  listSessions: vi.fn<() => Promise<SessionConfig[]>>(async () => []),
  markSessionConnected: vi.fn(async () => 0),
  readDbeaverCredentialsForDataSources: vi.fn(async () => ({})),
  readFileBytes: vi.fn(async () => new Uint8Array()),
  readPlistSessionFile: vi.fn(async () => ({ text: "", path: "", relativePath: "" })),
  saveSession: vi.fn<(cfg: SessionConfig) => Promise<void>>(async () => undefined),
  saveSessionGroup: vi.fn(async () => undefined),
  scanLocalSessionFiles: vi.fn(async () => []),
  selectFilePath: vi.fn(async () => null),
  tabbyDecryptVault: vi.fn(async () => ({ secrets: [] })),
  vaultPut: vi.fn(async () => ({ id: "vault-test", reference: "vault:test" })),
}));

vi.mock("../../lib/ipc", () => ipcMocks);

vi.mock("../../lib/vaultGate", () => ({
  ensureVaultReady: vi.fn(async () => true),
}));

const scrollIntoView = vi.fn();

function makeSession(id: string, name: string, groupPath: string): SessionConfig {
  return {
    id,
    name,
    session_type: "SSH",
    group_path: groupPath,
    host: `${id}.example.test`,
    port: 22,
    username: "root",
    auth_method: "None",
    options_json: "{}",
    created_at: 0,
    updated_at: 0,
    last_connected_at: null,
    sort_order: 0,
  };
}

function makeGroup(path: string): SessionGroup {
  return {
    id: path,
    name: path,
    parent_id: null,
    sort_order: 0,
    icon: null,
  };
}

function sessionRow(id: string): HTMLElement {
  const row = document.querySelector(`[data-testid="session-tree-item"][data-session-id="${id}"]`);
  if (!(row instanceof HTMLElement)) throw new Error(`Session row ${id} not found`);
  return row;
}

describe("SessionTree range selection and drag", () => {
  const sessions = [
    makeSession("a", "Alpha", "first"),
    makeSession("c", "Charlie", "first"),
    makeSession("b", "Bravo", "first"),
    makeSession("hidden", "Hidden", "middle"),
    makeSession("z", "Zulu", "last"),
  ];
  const groups = [makeGroup("first"), makeGroup("middle"), makeGroup("last"), makeGroup("target")];

  beforeEach(() => {
    vi.clearAllMocks();
    ipcMocks.listSessions.mockResolvedValue(sessions);
    ipcMocks.listSessionGroups.mockResolvedValue(groups);
    useSessionStore.setState({
      sessions, groups, loading: false, selectedSessionId: null, selectedSessionIds: [], searchQuery: "",
    });
  });

  afterEach(async () => {
    fireEvent.keyDown(window, { key: "Escape" });
    cleanup();
    vi.unstubAllGlobals();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });

  function openFolders() {
    fireEvent.click(screen.getByText("first"));
    fireEvent.click(screen.getByText("last"));
  }

  function selectedIds() {
    return [...useSessionStore.getState().selectedSessionIds].sort();
  }

  function pointer(target: HTMLElement | Window, type: string, x: number, y: number) {
    return fireEvent(target, new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
  }

  it("selects a visible range in tree order and retains its anchor for subsequent Shift clicks", () => {
    render(<SessionTree />);
    openFolders();
    fireEvent.click(sessionRow("a"));
    fireEvent.click(sessionRow("z"), { shiftKey: true });
    expect(selectedIds()).toEqual(["a", "b", "c", "z"]);
    fireEvent.click(sessionRow("b"), { shiftKey: true });
    expect(selectedIds()).toEqual(["a", "b"]);
    expect(useSessionStore.getState().selectedSessionId).toBe("b");
  });

  it("supports reverse ranges, additive Ctrl+Shift ranges, and Meta toggling", () => {
    render(<SessionTree />);
    openFolders();
    fireEvent.click(sessionRow("z"));
    fireEvent.click(sessionRow("c"), { ctrlKey: true });
    fireEvent.click(sessionRow("a"), { ctrlKey: true, shiftKey: true });
    expect(selectedIds()).toEqual(["a", "b", "c", "z"]);
    fireEvent.click(sessionRow("b"), { metaKey: true });
    expect(selectedIds()).toEqual(["a", "c", "z"]);
    fireEvent.click(sessionRow("z"));
    expect(selectedIds()).toEqual(["z"]);
    fireEvent.click(sessionRow("a"), { shiftKey: true });
    expect(selectedIds()).toEqual(["a", "b", "c", "z"]);
  });

  it("ranges only over search results and handles a hidden or missing anchor", () => {
    const searchableSessions = sessions.map((session) => session.group_path === "first" ? { ...session, name: `Range ${session.name}` } : session);
    ipcMocks.listSessions.mockResolvedValue(searchableSessions);
    useSessionStore.setState({ sessions: searchableSessions, searchQuery: "range", selectedSessionId: "hidden", selectedSessionIds: ["hidden"] });
    render(<SessionTree />);
    fireEvent.click(sessionRow("a"), { shiftKey: true });
    expect(selectedIds()).toEqual(["a"]);
    fireEvent.click(sessionRow("c"), { shiftKey: true });
    expect(selectedIds()).toEqual(["a", "b", "c"]);
    expect(document.querySelector('[data-session-id="hidden"]')).toBeNull();
  });

  it("prevents text selection and drags the entire selection with a count preview", async () => {
    render(<SessionTree />);
    openFolders();
    fireEvent.click(sessionRow("a"));
    fireEvent.click(sessionRow("c"), { ctrlKey: true });
    const target = screen.getByText("target");
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
    expect(pointer(sessionRow("a"), "pointerdown", 20, 40)).toBe(false);
    pointer(window, "pointermove", 25, 40);
    expect(document.querySelector('[data-custom-drag-ghost="true"]')).toHaveTextContent("Move 2 sessions");
    expect(selectedIds()).toEqual(["a", "c"]);
    pointer(window, "pointerup", 25, 40);
    fireEvent.click(sessionRow("a")); // The compatibility click following a drag must not collapse selection.
    await waitFor(() => expect(ipcMocks.saveSession).toHaveBeenCalledTimes(2));
    expect(ipcMocks.saveSession.mock.calls.map(([session]) => [session.id, session.group_path])).toEqual([
      ["a", "User sessions / target"], ["c", "User sessions / target"],
    ]);
    expect(selectedIds()).toEqual(["a", "c"]);
    expect(document.querySelector('[data-custom-drag-ghost="true"]')).toBeNull();
  });

  it("cancels a batch drag without saving, then drags an unselected row alone", async () => {
    render(<SessionTree />);
    openFolders();
    fireEvent.click(sessionRow("a"));
    fireEvent.click(sessionRow("c"), { ctrlKey: true });
    const target = screen.getByText("target");
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
    pointer(sessionRow("a"), "pointerdown", 20, 40);
    pointer(window, "pointermove", 30, 40);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(ipcMocks.saveSession).not.toHaveBeenCalled();
    expect(document.querySelector('[data-custom-drag-ghost="true"]')).toBeNull();
    expect(selectedIds()).toEqual(["a", "c"]);
    pointer(sessionRow("z"), "pointerdown", 20, 40);
    pointer(window, "pointermove", 30, 40);
    expect(selectedIds()).toEqual(["z"]);
    pointer(window, "pointerup", 30, 40);
    await waitFor(() => expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1));
    expect(ipcMocks.saveSession.mock.calls[0][0]).toMatchObject({ id: "z", group_path: "User sessions / target" });
  });

  it("keeps the existing selection until a press becomes a drag or click", () => {
    render(<SessionTree />);
    openFolders();
    fireEvent.click(sessionRow("a"));
    fireEvent.click(sessionRow("c"), { ctrlKey: true });
    pointer(sessionRow("z"), "pointerdown", 20, 40);
    expect(selectedIds()).toEqual(["a", "c"]);
    pointer(window, "pointerup", 21, 40);
    expect(ipcMocks.saveSession).not.toHaveBeenCalled();
    fireEvent.click(sessionRow("z"));
    expect(selectedIds()).toEqual(["z"]);
  });
});

describe("SessionTree multi-select connect", () => {
  const sessions = [
    makeSession("ipy-145", "145.216", "ipy"),
    makeSession("person-cloudcone", "cloudcone-cf-tun-local", "person"),
    makeSession("ipy-152", "152.92", "ipy"),
  ];
  const groups = [makeGroup("ipy"), makeGroup("person")];

  beforeEach(() => {
    resetSystemFontCacheForTests();
    vi.clearAllMocks();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    ipcMocks.listSessions.mockResolvedValue(sessions);
    ipcMocks.listSessionGroups.mockResolvedValue(groups);
    useSessionStore.setState({
      sessions,
      groups,
      loading: false,
      selectedSessionId: null,
      selectedSessionIds: [],
      searchQuery: "",
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("connects Ctrl-selected sessions across folders from the session context menu", () => {
    const onConnectSession = vi.fn();
    render(<SessionTree onConnectSession={onConnectSession} />);

    fireEvent.click(screen.getByText("ipy"));
    fireEvent.click(screen.getByText("person"));

    fireEvent.click(sessionRow("ipy-145"), { ctrlKey: true });
    fireEvent.click(sessionRow("person-cloudcone"), { ctrlKey: true });

    expect(sessionRow("ipy-145")).toHaveAttribute("data-selected", "true");
    expect(sessionRow("person-cloudcone")).toHaveAttribute("data-selected", "true");

    fireEvent.contextMenu(sessionRow("person-cloudcone"));
    fireEvent.click(screen.getByTestId("context-menu-item-connect-selected-sessions-2"));

    expect(onConnectSession).toHaveBeenCalledTimes(2);
    expect(onConnectSession.mock.calls.map(([session]) => session.id)).toEqual([
      "ipy-145",
      "person-cloudcone",
    ]);
  });

  it("labels saved WSL sessions as WSL in the tree", () => {
    const wslSession: SessionConfig = {
      ...makeSession("wsl-ubuntu", "WSL: Ubuntu", "ipy"),
      session_type: "LocalShell",
      host: "",
      port: 0,
      username: null,
      options_json: JSON.stringify({
        localShellPath: "wsl.exe",
        localShellArgs: ["-d", "Ubuntu"],
      }),
    };
    ipcMocks.listSessions.mockResolvedValue([wslSession]);
    useSessionStore.setState({
      sessions: [wslSession],
      groups,
      loading: false,
      selectedSessionId: null,
      searchQuery: "",
    });

    render(<SessionTree />);
    fireEvent.click(screen.getByText("ipy"));

    expect(sessionRow("wsl-ubuntu")).toHaveAttribute("data-session-type", "WSL");
    expect(sessionRow("wsl-ubuntu")).toHaveTextContent("WSL");
  });

  it("expands and scrolls to an externally selected session", async () => {
    useSessionStore.setState({
      sessions,
      groups,
      loading: false,
      selectedSessionId: "person-cloudcone",
      selectedSessionIds: ["person-cloudcone"],
      searchQuery: "",
    });

    render(<SessionTree />);

    await waitFor(() => {
      expect(sessionRow("person-cloudcone")).toHaveAttribute("data-selected", "true");
    });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });
});

describe("SessionTree multi-select batch operations", () => {
  const sessions = [
    makeSession("ipy-145", "145.216", "ipy"),
    makeSession("ipy-152", "152.92", "ipy"),
    makeSession("person-x", "x-host", "person"),
  ];
  const groups = [makeGroup("ipy"), makeGroup("person")];

  beforeEach(() => {
    vi.clearAllMocks();
    ipcMocks.listSessions.mockResolvedValue(sessions);
    ipcMocks.listSessionGroups.mockResolvedValue(groups);
    useSessionStore.setState({
      sessions,
      groups,
      loading: false,
      selectedSessionId: null,
      selectedSessionIds: [],
      searchQuery: "",
    });
  });

  afterEach(() => {
    cleanup();
  });

  function selectBothIpySessions() {
    fireEvent.click(screen.getByText("ipy"));
    fireEvent.click(sessionRow("ipy-145"), { ctrlKey: true });
    fireEvent.click(sessionRow("ipy-152"), { ctrlKey: true });
  }

  it("deletes the whole selection after confirmation", async () => {
    render(<SessionTree />);
    selectBothIpySessions();

    fireEvent.contextMenu(sessionRow("ipy-152"));
    fireEvent.click(screen.getByTestId("context-menu-item-delete-selected-sessions-2"));

    // Multi-delete is gated behind a confirmation dialog.
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));

    await waitFor(() => expect(ipcMocks.deleteSession).toHaveBeenCalledTimes(2));
    expect(ipcMocks.deleteSession.mock.calls.map(([id]) => id).sort()).toEqual([
      "ipy-145",
      "ipy-152",
    ]);
  });

  it("confirms before deleting a single session from the context menu", async () => {
    render(<SessionTree />);
    fireEvent.click(screen.getByText("ipy"));
    fireEvent.contextMenu(sessionRow("ipy-145"));
    fireEvent.click(screen.getByTestId("context-menu-item-delete"));

    // A single delete is now gated behind the same confirmation dialog as
    // the batch delete — nothing happens until the user confirms.
    expect(ipcMocks.deleteSession).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));

    await waitFor(() => expect(ipcMocks.deleteSession).toHaveBeenCalledTimes(1));
    expect(ipcMocks.deleteSession).toHaveBeenCalledWith("ipy-145");
  });

  it("keeps the session when the single-delete confirmation is cancelled", async () => {
    render(<SessionTree />);
    fireEvent.click(screen.getByText("ipy"));
    fireEvent.contextMenu(sessionRow("ipy-145"));
    fireEvent.click(screen.getByTestId("context-menu-item-delete"));

    fireEvent.click(await screen.findByTestId("confirm-dialog-cancel"));
    expect(ipcMocks.deleteSession).not.toHaveBeenCalled();
  });

  it("duplicates the whole selection from the context menu", async () => {
    render(<SessionTree />);
    selectBothIpySessions();

    fireEvent.contextMenu(sessionRow("ipy-145"));
    fireEvent.click(screen.getByTestId("context-menu-item-duplicate-selected-sessions-2"));

    await waitFor(() => expect(ipcMocks.saveSession).toHaveBeenCalledTimes(2));
    expect(ipcMocks.saveSession.mock.calls.map(([cfg]) => cfg.name)).toEqual([
      "145.216 (copy)",
      "152.92 (copy)",
    ]);
  });

  it("exposes SSH connection command copy presets from the context menu", async () => {
    render(<SessionTree />);
    fireEvent.click(screen.getByText("ipy"));

    fireEvent.contextMenu(sessionRow("ipy-145"));
    const copyCommand = screen.getByTestId("context-menu-item-copy-connection-command");
    fireEvent.mouseEnter(copyCommand.parentElement!);

    const posix = await screen.findByTestId("context-menu-item-copy-command-posix");
    expect(posix).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-copy-command-powershell")).toBeInTheDocument();

    fireEvent.mouseEnter(posix.parentElement!);
    expect(await screen.findByTestId("context-menu-item-copy-command-posix-basic")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-copy-command-posix-jump")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-copy-command-posix-forwards")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-copy-command-posix-full")).toBeInTheDocument();
  });

  it("sets a terminal theme for the selected sessions from the context menu", async () => {
    render(<SessionTree />);
    selectBothIpySessions();

    fireEvent.contextMenu(sessionRow("ipy-145"));
    const item = screen.getByTestId("context-menu-item-set-terminal-theme");
    fireEvent.mouseEnter(item.parentElement!);
    fireEvent.click(await screen.findByTestId("session-terminal-theme-option-kanagawa-wave"));

    await waitFor(() => expect(ipcMocks.saveSession).toHaveBeenCalledTimes(2));
    const savedOptions = ipcMocks.saveSession.mock.calls.map(([cfg]) => JSON.parse(cfg.options_json));
    expect(savedOptions.map((options) => options.terminalProfile.theme)).toEqual([
      "kanagawa-wave",
      "kanagawa-wave",
    ]);
  });

  it("sets a terminal font for the selected sessions from the context menu", async () => {
    render(<SessionTree />);
    selectBothIpySessions();

    fireEvent.contextMenu(sessionRow("ipy-145"));
    const item = screen.getByTestId("context-menu-item-set-terminal-theme");
    fireEvent.mouseEnter(item.parentElement!);
    const fontSelect = await screen.findByTestId("session-terminal-font-select");
    expect(ipcMocks.listSystemFonts).not.toHaveBeenCalled();
    fireEvent.click(fontSelect);
    fireEvent.click(await screen.findByRole("option", { name: "JetBrains Mono" }));
    expect(ipcMocks.listSystemFonts).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(ipcMocks.saveSession).toHaveBeenCalledTimes(2));
    const savedOptions = ipcMocks.saveSession.mock.calls.map(([cfg]) => JSON.parse(cfg.options_json));
    expect(savedOptions.map((options) => options.terminalProfile.fontFamily)).toEqual([
      expect.stringContaining("JetBrains Mono"),
      expect.stringContaining("JetBrains Mono"),
    ]);
  });

  it("keeps the session appearance menu draft current for repeated font size changes", async () => {
    render(<SessionTree />);
    selectBothIpySessions();

    fireEvent.contextMenu(sessionRow("ipy-145"));
    const item = screen.getByTestId("context-menu-item-set-terminal-theme");
    fireEvent.mouseEnter(item.parentElement!);

    const fontSizeInput = await screen.findByTestId("session-terminal-font-size");
    const increase = await screen.findByLabelText("Increase text size");
    fireEvent.click(increase);
    expect(fontSizeInput).toHaveValue("15");
    fireEvent.click(increase);
    expect(fontSizeInput).toHaveValue("16");

    await waitFor(() => expect(ipcMocks.saveSession).toHaveBeenCalledTimes(4));
    const savedFontSizes = ipcMocks.saveSession.mock.calls.map(([cfg]) => (
      JSON.parse(cfg.options_json).terminalProfile.fontSize
    ));
    expect(savedFontSizes.filter((size) => size === 16)).toHaveLength(2);
  });

  it("keeps session appearance draft patches cumulative while saves are pending", async () => {
    render(<SessionTree />);
    selectBothIpySessions();

    fireEvent.contextMenu(sessionRow("ipy-145"));
    const item = screen.getByTestId("context-menu-item-set-terminal-theme");
    fireEvent.mouseEnter(item.parentElement!);

    fireEvent.click(await screen.findByTestId("session-terminal-theme-option-kanagawa-wave"));
    fireEvent.click(await screen.findByLabelText("Increase text size"));

    await waitFor(() => expect(ipcMocks.saveSession).toHaveBeenCalledTimes(4));
    const lastTwo = ipcMocks.saveSession.mock.calls.slice(-2).map(([cfg]) => JSON.parse(cfg.options_json));
    expect(lastTwo.map((options) => options.terminalProfile.theme)).toEqual([
      "kanagawa-wave",
      "kanagawa-wave",
    ]);
    expect(lastTwo.map((options) => options.terminalProfile.fontSize)).toEqual([15, 15]);
  });
});
