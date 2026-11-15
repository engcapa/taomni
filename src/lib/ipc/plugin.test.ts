import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { invokePlugin, listPlugins, setPluginEnabled } from "./plugin";

describe("invokePlugin", () => {
  beforeEach(() => invokeMock.mockReset());

  it("uses the namespaced plugin_invoke command and preserves payload/request id", async () => {
    invokeMock.mockResolvedValueOnce({ ok: true });
    await expect(invokePlugin("rdp-client", "connect", { sessionId: "s1" }, { requestId: "req-1" })).resolves.toEqual({ ok: true });
    expect(invokeMock).toHaveBeenCalledWith("plugin_invoke", {
      slug: "rdp-client",
      command: "connect",
      payload: { sessionId: "s1" },
      requestId: "req-1",
    });
  });

  it("rejects unsafe slugs and command names before crossing IPC", async () => {
    await expect(invokePlugin("../rdp", "connect")).rejects.toThrow("Invalid plugin slug");
    await expect(invokePlugin("rdp", "../connect")).rejects.toThrow("Invalid plugin command");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("exposes lifecycle operations through the same typed IPC boundary", async () => {
    invokeMock.mockResolvedValueOnce([]).mockResolvedValueOnce({ slug: "rdp-client", state: "enabled" });
    await expect(listPlugins()).resolves.toEqual([]);
    await expect(setPluginEnabled("rdp-client", true)).resolves.toMatchObject({ lifecycle: "enabled" });
    expect(invokeMock).toHaveBeenNthCalledWith(1, "plugin_list", {});
    expect(invokeMock).toHaveBeenNthCalledWith(2, "plugin_set_enabled", { slug: "rdp-client", enabled: true });
  });
});

