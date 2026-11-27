import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../lib/i18n";
import { useModuleInstallStore } from "../../stores/moduleInstallStore";
import { useModuleStore } from "../../stores/moduleStore";
import { ModuleOfflineInstall } from "./ModuleOfflineInstall";

const mocks = vi.hoisted(() => ({ install: vi.fn(), list: vi.fn(), select: vi.fn() }));
vi.mock("../../lib/ipc/plugin", () => ({ installPluginArchive: mocks.install, listPlugins: mocks.list }));
vi.mock("../../lib/ipc/files", () => ({ selectOnePath: mocks.select }));

function fill() {
  fireEvent.change(screen.getByTestId("module-offline-archive"), { target: { value: "/test/module.taomni-plugin" } });
  fireEvent.change(screen.getByTestId("module-offline-signature"), { target: { value: "untrusted-signature" } });
}

describe("ModuleOfflineInstall", () => {
  beforeEach(() => {
    setLocale("en");
    vi.clearAllMocks();
    useModuleStore.getState().hydrate([]);
    useModuleInstallStore.setState({
      archivePath: "", detachedSignature: "", phase: "idle", error: null, validationError: false,
      refreshError: null, installed: null, completionRevision: 0,
    });
  });
  afterEach(cleanup);

  it("associates the missing signature with the validation message and preserves the package path", () => {
    render(<ModuleOfflineInstall />);
    const archive = screen.getByTestId("module-offline-archive");
    const signature = screen.getByTestId("module-offline-signature");
    fireEvent.change(archive, { target: { value: "/test/draft.taomni-plugin" } });
    fireEvent.click(screen.getByTestId("module-offline-submit"));
    expect(archive).not.toHaveAttribute("aria-invalid");
    expect(archive).toHaveValue("/test/draft.taomni-plugin");
    expect(signature).toHaveAttribute("aria-invalid", "true");
    expect(signature).toHaveAccessibleDescription(screen.getByRole("alert").textContent!);
    expect(mocks.install).not.toHaveBeenCalled();
    fireEvent.change(signature, { target: { value: "editing" } });
    expect(signature).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows required validation and a native rejection without inventing an installed record", async () => {
    mocks.install.mockRejectedValueOnce(new Error("untrusted signature"));
    render(<ModuleOfflineInstall />);
    fireEvent.click(screen.getByTestId("module-offline-submit"));
    expect(screen.getByTestId("module-offline-error")).toBeVisible();
    expect(mocks.install).not.toHaveBeenCalled();
    fill();
    fireEvent.click(screen.getByTestId("module-offline-submit"));
    await waitFor(() => expect(screen.getByTestId("module-offline-error")).toHaveTextContent("untrusted signature"));
    expect(screen.getByTestId("module-offline-install")).toHaveAttribute("data-phase", "failed");
    expect(useModuleStore.getState().records).toEqual({});
  });

  it("restores the draft and operation while closed, then retains the failure and allows retry", async () => {
    let reject!: (reason: Error) => void;
    mocks.install.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    const view = render(<ModuleOfflineInstall />);
    fill();
    fireEvent.click(screen.getByTestId("module-offline-submit"));
    await waitFor(() => expect(mocks.install).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("module-offline-submit")).toBeDisabled();
    view.unmount();
    const reopened = render(<ModuleOfflineInstall />);
    expect(screen.getByTestId("module-offline-install")).toHaveAttribute("data-phase", "verifying");
    expect(screen.getByTestId("module-offline-archive")).toHaveValue("/test/module.taomni-plugin");
    expect(screen.getByTestId("module-offline-signature")).toHaveValue("untrusted-signature");
    await act(async () => { reject(new Error("signature rejected")); });
    reopened.unmount();
    render(<ModuleOfflineInstall />);
    expect(screen.getByTestId("module-offline-error")).toHaveTextContent("signature rejected");
    expect(screen.getByTestId("module-offline-submit")).toBeEnabled();
    mocks.install.mockRejectedValueOnce(new Error("rejected again"));
    fireEvent.click(screen.getByTestId("module-offline-submit"));
    await waitFor(() => expect(screen.getByTestId("module-offline-error")).toHaveTextContent("rejected again"));
  });

  it("refreshes the registry only after native success, including completion while closed", async () => {
    const installed = { slug: "hello-plugin", manifest: null, lifecycle: "installed" };
    mocks.install.mockResolvedValueOnce(installed);
    mocks.list.mockResolvedValueOnce([installed]);
    const callback = vi.fn();
    const view = render(<ModuleOfflineInstall onRegistryChanged={callback} />);
    fill();
    view.unmount();
    await act(async () => { await useModuleInstallStore.getState().install(); });
    expect(callback).not.toHaveBeenCalled();
    expect(useModuleStore.getState().records["hello-plugin"].lifecycle).toBe("installed");
    render(<ModuleOfflineInstall onRegistryChanged={callback} />);
    expect(screen.getByTestId("module-offline-install")).toHaveAttribute("data-phase", "completed");
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("uses the existing native picker and preserves a draft when selection is cancelled", async () => {
    mocks.select.mockResolvedValueOnce("/picked/module.taomni-plugin").mockResolvedValueOnce(null);
    render(<ModuleOfflineInstall />);
    fireEvent.click(screen.getByTestId("module-offline-choose"));
    await waitFor(() => expect(screen.getByTestId("module-offline-archive")).toHaveValue("/picked/module.taomni-plugin"));
    fireEvent.click(screen.getByTestId("module-offline-choose"));
    await waitFor(() => expect(mocks.select).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("module-offline-archive")).toHaveValue("/picked/module.taomni-plugin");
  });
});
