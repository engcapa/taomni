import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SdkSettings } from "./SdkSettings";

const sdkMocks = vi.hoisted(() => ({
  discover: vi.fn(),
  getRegistry: vi.fn(),
  probe: vi.fn(),
  refresh: vi.fn(),
  remove: vi.fn(),
  save: vi.fn(),
  setDefault: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}));

const ipcMocks = vi.hoisted(() => ({
  selectFolderPath: vi.fn(),
}));

vi.mock("../../lib/editor/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/editor/sdk")>();
  return {
    ...actual,
    sdkDiscoverInstallations: sdkMocks.discover,
    sdkGetRegistry: sdkMocks.getRegistry,
    sdkProbeInstallation: sdkMocks.probe,
    sdkRefreshInstallations: sdkMocks.refresh,
    sdkRemoveInstallation: sdkMocks.remove,
    sdkSaveInstallation: sdkMocks.save,
    sdkSetDefault: sdkMocks.setDefault,
    subscribeSdkRegistryChanged: sdkMocks.subscribe,
  };
});

vi.mock("../../lib/ipc", () => ipcMocks);

const java = {
  id: "jdk-21",
  kind: "java" as const,
  name: "Temurin 21",
  location: "C:\\jdks\\temurin-21",
  executables: { java: "C:\\jdks\\temurin-21\\bin\\java.exe" },
  version: "21.0.6",
  vendor: "Eclipse Adoptium",
  architecture: "x86_64",
  origin: "manual" as const,
  status: "ready" as const,
  lastError: null,
  lastProbedAt: "2026-07-18T00:00:00Z",
};

describe("SdkSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdkMocks.getRegistry.mockResolvedValue({
      schemaVersion: 1,
      installations: [java],
      defaults: [{ kind: "java", sdkId: java.id }],
      bindings: [],
    });
    sdkMocks.discover.mockResolvedValue([]);
    sdkMocks.probe.mockResolvedValue({
      kind: "kotlin",
      location: "C:\\kotlin",
      executables: { kotlinc: "C:\\kotlin\\bin\\kotlinc.bat" },
      version: "2.3.20",
      vendor: null,
      architecture: "x86_64",
      status: "ready",
      error: null,
      source: null,
    });
    sdkMocks.save.mockResolvedValue({});
    sdkMocks.refresh.mockResolvedValue([]);
    sdkMocks.remove.mockResolvedValue(undefined);
    sdkMocks.setDefault.mockResolvedValue(undefined);
    ipcMocks.selectFolderPath.mockResolvedValue(null);
  });

  afterEach(cleanup);

  it("shows all SDK kinds and the configured default", async () => {
    render(<SdkSettings />);

    expect(await screen.findByTestId("sdk-row-jdk-21")).toHaveTextContent("Temurin 21");
    expect(screen.getByTestId("sdk-kind-kotlin")).toHaveTextContent("No installations registered");
    expect(screen.getByTestId("sdk-kind-scala")).toBeInTheDocument();
    expect(screen.getByTestId("sdk-kind-python")).toBeInTheDocument();
    expect(screen.getByTestId("sdk-default-java")).toHaveValue("jdk-21");
  });

  it("probes and saves a Kotlin SDK without treating it as a JDK", async () => {
    const user = userEvent.setup();
    render(<SdkSettings />);
    await screen.findByTestId("sdk-row-jdk-21");

    await user.click(screen.getByRole("button", { name: "Add SDK Kotlin" }));
    fireEvent.change(screen.getByTestId("sdk-editor-location"), {
      target: { value: "C:\\kotlin" },
    });
    await user.click(screen.getByTestId("sdk-editor-probe-button"));

    expect(sdkMocks.probe).toHaveBeenCalledWith("kotlin", "C:\\kotlin");
    expect(await screen.findByTestId("sdk-editor-probe")).toHaveTextContent("2.3.20");

    await user.click(screen.getByTestId("sdk-editor-save"));
    await waitFor(() => expect(sdkMocks.save).toHaveBeenCalledWith({
      id: null,
      kind: "kotlin",
      name: null,
      location: "C:\\kotlin",
      origin: "manual",
    }));
  });

  it("discovers and registers a Python environment", async () => {
    const user = userEvent.setup();
    sdkMocks.discover.mockResolvedValue([{
      kind: "python",
      location: "C:\\repo\\.venv",
      executables: { python: "C:\\repo\\.venv\\Scripts\\python.exe" },
      version: "3.13.5",
      vendor: null,
      architecture: "x86_64",
      status: "ready",
      error: null,
      source: "workspace",
    }]);
    render(<SdkSettings />);
    await screen.findByTestId("sdk-row-jdk-21");

    await user.click(screen.getByTestId("sdk-discover"));
    expect(await screen.findByTestId("sdk-discovery-results")).toHaveTextContent("C:\\repo\\.venv");
    await user.click(screen.getAllByRole("button", { name: "Add SDK" }).at(-1)!);

    await waitFor(() => expect(sdkMocks.save).toHaveBeenCalledWith({
      kind: "python",
      location: "C:\\repo\\.venv",
      origin: "discovered",
    }));
  });

  it("changes defaults and removes an installation after confirmation", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SdkSettings />);
    await screen.findByTestId("sdk-row-jdk-21");

    fireEvent.change(screen.getByTestId("sdk-default-java"), { target: { value: "" } });
    await waitFor(() => expect(sdkMocks.setDefault).toHaveBeenCalledWith("java", null));

    await user.click(screen.getByRole("button", { name: "Remove Temurin 21" }));
    await waitFor(() => expect(sdkMocks.remove).toHaveBeenCalledWith("jdk-21"));
  });
});
