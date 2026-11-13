import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmAppDialog } from "../../lib/appDialogs";
import { SERVER_ORDER, defaultConfig, type ServerConfig, type ServerType } from "../../lib/servers";
import { useServersStore } from "../../stores/serversStore";
import { ServersPanel } from "./ServersPanel";
import { ServersTabBlockedDialog } from "./ServersTabBlockedDialog";

vi.mock("../../lib/appDialogs", () => ({
  confirmAppDialog: vi.fn(async () => true),
}));

vi.mock("../../lib/vaultGate", () => ({
  ensureVaultReady: vi.fn(async () => true),
}));

vi.mock("../../lib/servers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/servers")>();
  return {
    ...actual,
    loadServerConfigs: vi.fn(async () => ({})),
    listServerStatuses: vi.fn(async () => []),
    listServerLogs: vi.fn(async () => ({})),
    listenServerOutput: vi.fn(async () => () => undefined),
    listenServerStatus: vi.fn(async () => () => undefined),
    saveServerConfig: vi.fn(async (_type, cfg) => cfg),
  };
});

function buildDefaultConfigs(): Record<ServerType, ServerConfig> {
  const configs = {} as Record<ServerType, ServerConfig>;
  for (const type of SERVER_ORDER) {
    configs[type] = defaultConfig(type);
  }
  return configs;
}

describe("ServersPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useServersStore.setState({
      configs: buildDefaultConfigs(),
      loaded: false,
      dirty: false,
      selectedServer: "ssh",
      tabBlockedMessage: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("closes immediately via Cancel when clean", async () => {
    const onClose = vi.fn();
    render(<ServersPanel onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId("servers-dialog")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("servers-dialog-cancel"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(confirmAppDialog).not.toHaveBeenCalled();
  });

  it("confirms discard when dirty before calling onClose", async () => {
    const onClose = vi.fn();
    render(<ServersPanel onClose={onClose} />);
    await waitFor(() => expect(useServersStore.getState().loaded).toBe(true));

    act(() => {
      useServersStore.getState().patchConfig("ssh", { port: 2223 });
    });

    vi.mocked(confirmAppDialog).mockResolvedValueOnce(false);
    fireEvent.click(screen.getByTestId("servers-dialog-cancel"));
    await waitFor(() => expect(confirmAppDialog).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();

    vi.mocked(confirmAppDialog).mockResolvedValueOnce(true);
    fireEvent.click(screen.getByTestId("servers-dialog-cancel"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(useServersStore.getState().dirty).toBe(false);
  });
});

describe("ServersTabBlockedDialog", () => {
  afterEach(() => {
    cleanup();
    useServersStore.getState().setTabBlockedMessage(null);
  });

  it("renders notice message and dismisses via OK or Escape", () => {
    render(<ServersTabBlockedDialog />);
    expect(screen.queryByTestId("servers-blocked-dialog")).not.toBeInTheDocument();

    act(() => {
      useServersStore.getState().setTabBlockedMessage("Already open in another Taomni instance.");
    });
    const dialog = screen.getByTestId("servers-blocked-dialog");
    expect(screen.getByTestId("servers-blocked-message")).toHaveTextContent(
      "Already open in another Taomni instance.",
    );

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByTestId("servers-blocked-dialog")).not.toBeInTheDocument();

    act(() => {
      useServersStore.getState().setTabBlockedMessage("Still open.");
    });
    fireEvent.click(screen.getByTestId("servers-blocked-ok"));
    expect(screen.queryByTestId("servers-blocked-dialog")).not.toBeInTheDocument();
  });
});
