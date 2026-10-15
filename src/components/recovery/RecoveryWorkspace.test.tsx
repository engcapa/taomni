import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecoveryWorkspace } from "./RecoveryWorkspace";
import type { RecoveryBootstrap } from "../../lib/runtimeRecovery";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), channels: [] as Array<{ id: number; onmessage: (data: number[]) => void }> }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  Channel: class {
    id = mocks.channels.length;
    onmessage = (_: unknown) => {};
    constructor() { mocks.channels.push(this); }
  },
}));
const bootstrap = (): RecoveryBootstrap => ({
  version: 1, instanceId: "native-process", generation: 2, revision: 1, recovering: true,
  limitation: "terminal-state-unverified",
  description: { activeTabId: "t1", tabs: [
    { id: "t1", kind: "terminal", title: "Original terminal", savedSessionId: "saved", terminalSessionId: "same-pty" },
    { id: "mail1", kind: "mail", title: "Mail", savedSessionId: "account1", terminalSessionId: null },
    { id: "db1", kind: "database", title: "Database", savedSessionId: "dbconfig", terminalSessionId: null },
  ] },
});
describe("limited recovery workspace", () => {
  beforeEach(() => { mocks.invoke.mockReset(); mocks.invoke.mockResolvedValue(undefined); mocks.channels.length = 0; });
  afterEach(cleanup);
  it("restores selection and metadata, no automatic connect/create/send even in StrictMode", async () => {
    render(<StrictMode><RecoveryWorkspace bootstrap={bootstrap()} /></StrictMode>);
    await screen.findByText("有限恢复界面已就绪");
    expect(screen.getAllByTestId("recovery-tab")).toHaveLength(3);
    expect(screen.getAllByTestId("recovery-tab")[0]).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("recovery-terminal-id")).toHaveTextContent("same-pty");
    fireEvent.click(screen.getAllByTestId("recovery-tab")[1]);
    expect(screen.getByTestId("recovery-mail-warning")).toHaveTextContent("自动发送已暂停");
    fireEvent.click(screen.getAllByTestId("recovery-tab")[2]);
    expect(screen.getByTestId("recovery-unknown")).toHaveTextContent("不要直接重复操作");
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(["recovery_ready"]);
  });
  it("missing description never opens Welcome or creates shells", async () => {
    render(<RecoveryWorkspace bootstrap={{ ...bootstrap(), description: null }} />);
    await screen.findByText("有限恢复界面已就绪");
    expect(screen.getByTestId("recovery-missing")).toBeVisible();
    expect(screen.queryByTestId("recovery-tab")).toBeNull();
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(["recovery_ready"]);
  });
  it("failed ready remains explicit and does not start a normal app as fallback", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("stale generation"));
    render(<RecoveryWorkspace bootstrap={bootstrap()} />);
    await screen.findByText(/恢复确认失败/);
    expect(screen.getByTestId("recovery-limitations")).toBeVisible();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
  it("observes original output only after explicit action, switching tabs revokes observation", async () => {
    render(<RecoveryWorkspace bootstrap={bootstrap()} />);
    await screen.findByText("有限恢复界面已就绪");
    expect(mocks.channels).toHaveLength(0);
    fireEvent.click(screen.getByTestId("recovery-observe"));
    await screen.findByText("已订阅原终端；无输出不代表任务已结束");
    expect(mocks.invoke.mock.calls[1][1].sessionId).toBe("same-pty");
    await act(async () => {
      mocks.channels[0].onmessage([72, 73]);
      await new Promise((done) => setTimeout(done, 40));
    });
    expect(screen.getByTestId("recovery-output")).toHaveTextContent("HI");
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getAllByTestId("recovery-tab")[1]);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("detach_terminal_output", { sessionId: "same-pty", channelId: 0 }));
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(["recovery_ready", "attach_terminal_output", "detach_terminal_output"]);
  });
  it("missing original terminal is visible, no automatic replacement", async () => {
    render(<RecoveryWorkspace bootstrap={bootstrap()} />);
    await screen.findByText("有限恢复界面已就绪");
    mocks.invoke.mockRejectedValueOnce(new Error("not found"));
    fireEvent.click(screen.getByTestId("recovery-observe"));
    await screen.findByText(/原终端不存在、已结束或无法接回/);
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(["recovery_ready", "attach_terminal_output"]);
  });
});
