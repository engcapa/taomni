import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  cancelPluginRequest,
  installPluginArchive,
  installStagedPlugin,
  invokePlugin,
  listPlugins,
  refreshPlugins,
  rollbackPlugin,
  setPluginEnabled,
  startPluginDownload,
  uninstallPlugin,
} from "./plugin";
import { validatePluginManifest } from "../pluginRegistry";
import { moduleRecord } from "../tests/pluginFrontendHarness";

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

  it("allows the declared protocol namespace in plugin commands", async () => {
    invokeMock.mockResolvedValueOnce({ pong: true });
    await expect(invokePlugin("hello-plugin", "hello/ping")).resolves.toEqual({ pong: true });
    expect(invokeMock).toHaveBeenCalledWith("plugin_invoke", { slug: "hello-plugin", command: "hello/ping" });
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

  it("hydrates native module identity from the Rust manifest when no top-level slug is serialized", async () => {
    const record = {
      manifest: { slug: "hello-plugin", version: "0.1.0" },
      state: "enabled", reason: null,
    };
    invokeMock.mockResolvedValueOnce([record]).mockResolvedValueOnce({ ...record, state: "disabled" });
    await expect(listPlugins()).resolves.toEqual([{
      ...record, slug: "hello-plugin", lifecycle: "enabled",
    }]);
    await expect(setPluginEnabled("hello-plugin", false)).resolves.toMatchObject({
      slug: "hello-plugin", lifecycle: "disabled", manifest: record.manifest,
    });
  });

  it("rejects unsafe lifecycle slugs before crossing IPC", async () => {
    await expect(installStagedPlugin("../hello", "1.0.0", "/tmp/staged")).rejects.toThrow("Invalid plugin slug");
    await expect(rollbackPlugin("Hello")).rejects.toThrow("Invalid plugin slug");
    await expect(uninstallPlugin("hello/plugin")).rejects.toThrow("Invalid plugin slug");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("normalizes nullable native entry paths without weakening manifest validation", async () => {
    const manifest = moduleRecord().manifest!;
    const entries = [
      { host: "taomni-plugin-host", frontend: null, protocol: 1 },
      { host: null, frontend: "frontend/index.js", protocol: 1 },
    ];
    invokeMock.mockResolvedValueOnce(entries.map((entry) => ({
      manifest: { ...manifest, entry }, state: "enabled",
    })));
    const records = await listPlugins();
    for (const [index, record] of records.entries()) {
      expect(validatePluginManifest(record.manifest).ok).toBe(true);
      expect(validatePluginManifest({ ...manifest, entry: entries[index] }).ok).toBe(false);
    }
    expect(records[0].manifest?.entry).toEqual({ host: "taomni-plugin-host", protocol: 1 });
    expect(records[1].manifest?.entry).toEqual({ frontend: "frontend/index.js", protocol: 1 });
  });

  it("preserves the native signature boundary for offline and catalog archives", async () => {
    invokeMock.mockResolvedValue({ state: "installed" });
    await installPluginArchive("/tmp/module.taomni-plugin", { pluginId: "taomni-plugin-mfa" });
    expect(invokeMock).toHaveBeenLastCalledWith("plugin_install_archive", {
      archivePath: "/tmp/module.taomni-plugin", pluginId: "taomni-plugin-mfa",
    });
    await installPluginArchive("/tmp/offline.taomni-plugin", { detachedSignature: "signature bytes" });
    expect(invokeMock).toHaveBeenLastCalledWith("plugin_install_archive", {
      archivePath: "/tmp/offline.taomni-plugin", detachedSignature: "signature bytes",
    });
  });

  it("cancels the correlated request without resending its command", async () => {
    invokeMock.mockResolvedValueOnce(true);
    await expect(cancelPluginRequest("mfa", "request-1")).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith("plugin_cancel_request", { slug: "mfa", requestId: "request-1" });
  });

  it("passes the catalogue digest and size to native download verification", async () => {
    const expectedSha256 = "ab".repeat(32);
    invokeMock.mockResolvedValueOnce({ phase: "connecting", downloaded: 0 });
    await startPluginDownload({
      id: "module-download", url: "https://example.test/module.taomni-plugin",
      partialPath: "/profile/.downloads/module.part", completedPath: "/profile/.downloads/module.pkg",
      expectedTotal: 42, expectedSha256, proxyMode: "none",
    });
    expect(invokeMock).toHaveBeenCalledWith("plugin_download_start", expect.objectContaining({
      id: "module-download", expectedTotal: 42, expectedSha256, proxyMode: "none",
    }));
  });
});

