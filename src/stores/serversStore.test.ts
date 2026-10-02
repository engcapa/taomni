import { beforeEach, describe, expect, it, vi } from "vitest";
import { mergeLogHistory, useServersStore } from "./serversStore";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("mergeLogHistory", () => {
  it("keeps the history and appends only lines it does not end with", () => {
    expect(mergeLogHistory(["[1] a", "[2] b"], ["[2] b", "[3] c"])).toEqual(["[1] a", "[2] b", "[3] c"]);
    expect(mergeLogHistory(["[1] a"], [])).toEqual(["[1] a"]);
    expect(mergeLogHistory([], ["[1] note"])).toEqual(["[1] note"]);
  });

  it("caps the merged log at the window's line limit", () => {
    const history = Array.from({ length: 500 }, (_, i) => `[h] ${i}`);
    const merged = mergeLogHistory(history, ["[l] new"]);
    expect(merged).toHaveLength(500);
    expect(merged[0]).toBe("[h] 1");
    expect(merged.at(-1)).toBe("[l] new");
  });
});

describe("serversStore log history", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      switch (command) {
        case "load_server_configs":
          return {};
        case "list_server_statuses":
          return [{ serverType: "rdp", status: "running" }];
        case "list_server_logs":
          return { rdp: ["[10:00:00] RDP server listening", "[10:00:05] clipboard: this computer -> client: text (#1)"] };
        default:
          return undefined;
      }
    });
  });

  it("shows lines logged while no Local servers window listened", async () => {
    useServersStore.getState().clearLog("rdp");
    useServersStore.getState().appendLog("rdp", "[10:00:05] clipboard: this computer -> client: text (#1)");
    await useServersStore.getState().loadAll();
    const runtime = useServersStore.getState().runtimes.rdp;
    expect(runtime.status).toBe("running");
    expect(runtime.logLines).toEqual([
      "[10:00:00] RDP server listening",
      "[10:00:05] clipboard: this computer -> client: text (#1)",
    ]);
  });

  it("clears the backend history together with the window's log", () => {
    useServersStore.getState().clearLog("rdp");
    expect(invokeMock).toHaveBeenCalledWith("clear_server_log", { serverType: "rdp" });
    expect(useServersStore.getState().runtimes.rdp.logLines).toEqual([]);
  });
});
