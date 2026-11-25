import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../lib/i18n";
import { useModuleNetworkStore } from "../../stores/moduleNetworkStore";
import { ModuleNetworkSettings } from "./ModuleNetworkSettings";

const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), appSave: vi.fn() }));
vi.mock("../../lib/ipc/plugin", () => ({ getModuleNetworkConfig: mocks.load, saveModuleNetworkConfig: mocks.save }));
vi.mock("../../lib/ipc", () => ({ listSessions: vi.fn().mockResolvedValue([]), saveAppProxyConfig: mocks.appSave }));
const custom = { enabled: false, mode: "manual", session_id: "", kind: "http", host: "feature.proxy", port: 3128, username: "", password_ref: "" };

describe("ModuleNetworkSettings", () => {
  beforeEach(() => {
    setLocale("en");
    vi.clearAllMocks();
    mocks.load.mockResolvedValue({ mode: "app", custom });
    mocks.save.mockResolvedValue(undefined);
    useModuleNetworkStore.setState({ config: null, loading: false, saving: false, error: null });
  });
  afterEach(cleanup);

  it("reuses the manual Settings editor and retains its independent values across modes and reopen", async () => {
    const view = render(<ModuleNetworkSettings />);
    await waitFor(() => expect(screen.getByTestId("module-network-mode")).toHaveValue("app"));
    fireEvent.change(screen.getByTestId("module-network-mode"), { target: { value: "custom" } });
    await waitFor(() => expect(screen.getByLabelText("Proxy host")).toHaveValue("feature.proxy"));
    fireEvent.change(screen.getByLabelText("Proxy host"), { target: { value: "independent.proxy" } });
    await waitFor(() => expect(mocks.save).toHaveBeenLastCalledWith({ mode: "custom", custom: { ...custom, host: "independent.proxy" } }));
    fireEvent.change(screen.getByTestId("module-network-mode"), { target: { value: "none" } });
    await waitFor(() => expect(screen.getByTestId("module-network-save-status")).toHaveAttribute("data-state", "saved"));
    expect(screen.queryByTestId("module-network-custom")).toBeNull();
    view.unmount();
    render(<ModuleNetworkSettings />);
    expect(screen.getByTestId("module-network-mode")).toHaveValue("none");
    fireEvent.change(screen.getByTestId("module-network-mode"), { target: { value: "custom" } });
    await waitFor(() => expect(screen.getByLabelText("Proxy host")).toHaveValue("independent.proxy"));
    expect(mocks.appSave).not.toHaveBeenCalled();
  });

  it("keeps a pending save after closing and provides an actionable native error on reopening", async () => {
    let reject!: (reason: Error) => void;
    mocks.save.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    const view = render(<ModuleNetworkSettings />);
    await waitFor(() => expect(screen.getByTestId("module-network-mode")).toBeVisible());
    fireEvent.change(screen.getByTestId("module-network-mode"), { target: { value: "none" } });
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => { reject(new Error("settings are read-only")); });
    render(<ModuleNetworkSettings />);
    expect(screen.getByRole("alert")).toHaveTextContent("settings are read-only");
    expect(screen.getByTestId("module-network-mode")).toHaveValue("none");
    fireEvent.click(screen.getByTestId("module-network-retry"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(mocks.save).toHaveBeenLastCalledWith({ mode: "none", custom });
  });
});
