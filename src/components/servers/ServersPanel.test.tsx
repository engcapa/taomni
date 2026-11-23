import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmAppDialog } from "../../lib/appDialogs";
import {
  SERVER_ORDER,
  defaultConfig,
  saveServerConfig,
  type ServerConfig,
  type ServerType,
} from "../../lib/servers";
import { useServersStore } from "../../stores/serversStore";
import { ensureVaultReady } from "../../lib/vaultGate";
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
      editedServers: new Set(),
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
    expect(useServersStore.getState().editedServers.size).toBe(0);
  });

  it("saves edited configs on Apply, logs running port-change hint, and closes cleanly afterward", async () => {
    const onClose = vi.fn();
    render(<ServersPanel onClose={onClose} />);
    await waitFor(() => expect(useServersStore.getState().loaded).toBe(true));

    act(() => {
      const store = useServersStore.getState();
      store.clearLog("http");
      store.setStatus("http", { serverType: "http", status: "running", pid: 4321 });
      store.selectServer("http");
      store.patchConfig("http", { port: 18080 });
    });

    fireEvent.click(screen.getByTestId("servers-dialog-apply"));

    await waitFor(() => expect(useServersStore.getState().editedServers.size).toBe(0));
    expect(saveServerConfig).toHaveBeenCalledTimes(1);
    expect(saveServerConfig).toHaveBeenCalledWith(
      "http",
      expect.objectContaining({ port: 18080 }),
    );
    expect(ensureVaultReady).not.toHaveBeenCalled();
    expect(useServersStore.getState().runtimes.http.logLines.join("\n")).toContain(
      "Restart server to apply port change",
    );

    fireEvent.click(screen.getByTestId("servers-dialog-cancel"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(confirmAppDialog).not.toHaveBeenCalled();
  });

  it("retries only the edited service whose credential save was cancelled", async () => {
    render(<ServersPanel />);
    await waitFor(() => expect(useServersStore.getState().loaded).toBe(true));
    act(() => {
      useServersStore.getState().patchConfig("http", { port: 18080 });
      useServersStore.getState().patchConfig("vnc", { password: "fixture-vnc-password" });
    });
    vi.mocked(ensureVaultReady).mockResolvedValueOnce(false);
    const apply = screen.getByTestId("servers-dialog-apply");
    fireEvent.click(apply);
    await waitFor(() => expect(apply).toBeEnabled());
    expect(saveServerConfig).toHaveBeenCalledTimes(1);
    expect(saveServerConfig).toHaveBeenCalledWith("http", expect.objectContaining({ port: 18080 }));
    expect(useServersStore.getState().editedServers).toEqual(new Set(["vnc"]));

    fireEvent.click(apply);
    await waitFor(() => expect(useServersStore.getState().editedServers.size).toBe(0));
    expect(saveServerConfig).toHaveBeenCalledTimes(2);
    expect(saveServerConfig).toHaveBeenLastCalledWith("vnc", expect.objectContaining({
      password: "fixture-vnc-password",
    }));
  });

  it("allows clearing and retyping NumberInput fields without prepending leading zeroes", async () => {
    render(<ServersPanel onClose={vi.fn()} />);
    await waitFor(() => expect(useServersStore.getState().loaded).toBe(true));

    const portInput = screen.getByTestId("server-field-port") as HTMLInputElement;
    expect(portInput.value).toBe("22");

    fireEvent.change(portInput, { target: { value: "" } });
    expect(portInput.value).toBe("");
    expect(useServersStore.getState().editedServers.size).toBe(0);

    for (const next of ["2", "22", "222", "2229"]) {
      fireEvent.change(portInput, { target: { value: next } });
    }
    expect(portInput.value).toBe("2229");
    expect(useServersStore.getState().configs.ssh.port).toBe(2229);
    expect(useServersStore.getState().editedServers).toEqual(new Set(["ssh"]));

    // Clearing and blurring without digits restores the last committed numeric value.
    fireEvent.change(portInput, { target: { value: "" } });
    fireEvent.blur(portInput);
    expect(portInput.value).toBe("2229");

    // Switching servers syncs the input draft to the newly selected server's port.
    fireEvent.click(screen.getByTestId("server-row-ftp"));
    await waitFor(() => expect((screen.getByTestId("server-field-port") as HTMLInputElement).value).toBe("21"));

    // Auto-stop seconds uses the shared NumberInput primitive as well.
    const autoStopToggle = screen.getByTestId("server-field-auto-stop") as HTMLInputElement;
    if (!autoStopToggle.checked) {
      fireEvent.click(autoStopToggle);
    }
    const autoStopInput = screen.getByTestId("server-field-auto-stop-seconds") as HTMLInputElement;
    fireEvent.change(autoStopInput, { target: { value: "" } });
    expect(autoStopInput.value).toBe("");
    fireEvent.change(autoStopInput, { target: { value: "120" } });
    expect(autoStopInput.value).toBe("120");
    expect(useServersStore.getState().configs.ftp.autoStopSeconds).toBe(120);
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
