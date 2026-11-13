import { beforeEach, describe, expect, it, vi } from "vitest";
import { openTerminalExplorer } from "./terminalExplorer";

const mocks = vi.hoisted(() => ({ open: vi.fn(), alert: vi.fn(), status: vi.fn(), platform: vi.fn(() => "linux") }));
vi.mock("./openExplorer", () => ({ openExplorer: mocks.open }));
vi.mock("../runtime", () => ({ getAppPlatform: mocks.platform }));
vi.mock("../appDialogs", () => ({ alertAppDialog: mocks.alert }));
vi.mock("../../stores/appStore", () => ({ useAppStore: { getState: () => ({ setStatusMessage: mocks.status }) } }));
beforeEach(() => { vi.clearAllMocks(); mocks.platform.mockReturnValue("linux"); mocks.open.mockResolvedValue("explorer"); });

describe("terminal Explorer activation", () => {
  it("queries cwd at activation and retains forceNew and workspace scope", async () => {
    const resolve = vi.fn(async () => "/new-cwd");
    await openTerminalExplorer(resolve, true, "workspace-a");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(mocks.open).toHaveBeenCalledWith("/new-cwd", { forceNew: true, workspaceId: "workspace-a" });
  });
  it.each([
    ["/D:/qa/report/previews", "D:\\qa\\report\\previews"],
    ["/d/qa/report/previews", "D:\\qa\\report\\previews"],
    ["D:/qa/report/previews", "D:/qa/report/previews"],
    ["\\\\server\\share\\files", "\\\\server\\share\\files"],
  ])("normalizes Windows local terminal report %s before dedupe and native listing", async (reported, expected) => {
    mocks.platform.mockReturnValue("windows");
    await openTerminalExplorer(async () => reported, false, "workspace-a");
    expect(mocks.open).toHaveBeenCalledWith(expected, { forceNew: false, workspaceId: "workspace-a" });
  });

  it("does not invent a Windows directory for a local Linux-subsystem cwd with no drive mapping", async () => {
    mocks.platform.mockReturnValue("windows");
    await openTerminalExplorer(async () => "/home/user");
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.alert).toHaveBeenCalledTimes(1);
  });

  it("unknown cwd prompts without opening home or a stale directory", async () => {
    await openTerminalExplorer(async () => null);
    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ message: expect.any(String) }));
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it("reports lookup failures without an unhandled menu promise", async () => {
    await openTerminalExplorer(async () => { throw new Error("terminal closed"); });
    expect(mocks.status).toHaveBeenCalledWith("Error: terminal closed");
    expect(mocks.open).not.toHaveBeenCalled();
  });
});
