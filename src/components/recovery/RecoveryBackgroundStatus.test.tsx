import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecoveryBackgroundStatus } from "./RecoveryBackgroundStatus";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
describe("recovery background queries", () => {
  beforeEach(() => { mocks.invoke.mockReset(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("does no automatic work or polling and only uses three existing read queries", async () => {
    mocks.invoke.mockImplementation(async (command: string) => command === "list_server_statuses"
      ? [{ serverType: "http", status: "running", pid: 42 }]
      : command === "list_tunnel_statuses" ? [{ id: "tunnel-1", status: "running" }]
        : { phase: "running", message: "active" });
    render(<RecoveryBackgroundStatus />);
    expect(mocks.invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("recovery-background-refresh"));
    fireEvent.click(screen.getByTestId("recovery-background-refresh"));
    await screen.findByText(/http: running \(PID 42\)/);
    expect(screen.getByTestId("recovery-background-status")).toHaveTextContent("tunnel-1: running");
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(["list_server_statuses", "list_tunnel_statuses", "sockscap_status"]);
    vi.useFakeTimers();
    await act(async () => { vi.advanceTimersByTime(10 * 60_000); });
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
  });

  it("keeps successful results when one manager fails and allows an explicit retry", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "list_tunnel_statuses") throw new Error("unavailable");
      return command === "list_server_statuses" ? [] : { phase: "recoveryRequired", message: "Network cleanup required" };
    });
    render(<RecoveryBackgroundStatus />);
    fireEvent.click(screen.getByTestId("recovery-background-refresh"));
    await screen.findByText(/隧道：查询失败/);
    expect(screen.getByTestId("recovery-background-status")).toHaveTextContent("recoveryRequired");
    mocks.invoke.mockImplementation(async (command: string) => command === "sockscap_status" ? { phase: "stopped", message: "stopped" } : []);
    fireEvent.click(screen.getByTestId("recovery-background-refresh"));
    await screen.findByText(/无已登记隧道/);
    expect(mocks.invoke).toHaveBeenCalledTimes(6);
  });

  it("ignores late query results after leaving and never starts or stops native work", async () => {
    let done!: (value: unknown) => void;
    mocks.invoke.mockReturnValueOnce(new Promise((resolve) => { done = resolve; }));
    mocks.invoke.mockResolvedValueOnce([]).mockResolvedValueOnce({ phase: "stopped", message: "" });
    const view = render(<RecoveryBackgroundStatus />);
    fireEvent.click(screen.getByTestId("recovery-background-refresh"));
    view.unmount();
    await act(async () => { done([]); });
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
  });
});
