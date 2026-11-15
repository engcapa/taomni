import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  installStagedPlugin,
  invokePlugin,
  listPlugins,
  refreshPlugins,
  rollbackPlugin,
  setPluginEnabled,
  uninstallPlugin,
} from "./plugin";

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

  it("keeps install, refresh, rollback, and uninstall payloads explicit", async () => {
    const record = { slug: "hello-plugin", state: "installed" };
    invokeMock
      .mockResolvedValueOnce(record)
      .mockResolvedValueOnce([record])
      .mockResolvedValueOnce({ ...record, state: "disabled" })
      .mockResolvedValueOnce({ ...record, state: "uninstalled" });

    await expect(installStagedPlugin("hello-plugin", "0.1.0", "/tmp/staged")).resolves.toMatchObject({ lifecycle: "installed" });
    await expect(refreshPlugins()).resolves.toHaveLength(1);
    await expect(rollbackPlugin("hello-plugin")).resolves.toMatchObject({ lifecycle: "disabled" });
    await expect(uninstallPlugin("hello-plugin", true)).resolves.toMatchObject({ lifecycle: "uninstalled" });

    expect(invokeMock).toHaveBeenNthCalledWith(1, "plugin_install_staged", {
      slug: "hello-plugin",
      version: "0.1.0",
      packageDir: "/tmp/staged",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "plugin_refresh", {});
    expect(invokeMock).toHaveBeenNthCalledWith(3, "plugin_rollback", { slug: "hello-plugin" });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "plugin_uninstall", { slug: "hello-plugin", deleteData: true });
  });

  it("rejects unsafe lifecycle slugs before crossing IPC", async () => {
    await expect(installStagedPlugin("../hello", "1.0.0", "/tmp/staged")).rejects.toThrow("Invalid plugin slug");
    await expect(rollbackPlugin("Hello")).rejects.toThrow("Invalid plugin slug");
    await expect(uninstallPlugin("hello/plugin")).rejects.toThrow("Invalid plugin slug");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

