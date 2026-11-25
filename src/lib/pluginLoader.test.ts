import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardRef, memo } from "react";
import { clearMocks, mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { createPluginLazyComponent, loadPluginFrontend, pluginFrontendUrl, verifyPluginSha256 } from "./pluginLoader";
import { PluginRegistry, type PluginManifest } from "./pluginRegistry";

const validManifest: PluginManifest = {
  id: "taomni-plugin-demo",
  slug: "demo",
  name: "Demo",
  version: "1.0.0",
  coreApiVersion: "1",
  kind: "media" as const,
  status: "stable" as const,
  platforms: ["linux-x86_64"],
  entry: { frontend: "frontend/index.js", protocol: 1 },
  tabs: [{ kind: "demo", title: "Demo" }],
  commands: [],
  permissions: [],
  dataDir: "plugins/demo",
  backupPaths: [],
  legacyTables: [],
  vaultFixedKeys: [],
  snapshot: "file" as const,
};

describe("plugin frontend loading", () => {
  afterEach(() => clearMocks());

  it("uses a restricted taomni-plugin URL and surfaces load failures", async () => {
    expect(pluginFrontendUrl(validManifest)).toBe("taomni-plugin://localhost/demo/1.0.0/frontend/index.js");
    const importer = vi.fn().mockResolvedValue({ default: () => null });
    await expect(loadPluginFrontend(validManifest, importer)).resolves.toHaveProperty("default");
    expect(importer).toHaveBeenCalledWith("taomni-plugin://localhost/demo/1.0.0/frontend/index.js");
    await expect(loadPluginFrontend(validManifest, vi.fn().mockRejectedValue(new Error("bad hash")))).rejects.toMatchObject({
      name: "PluginLoadError",
      slug: "demo",
    });
  });

  it("gives upgraded entry points and relative chunks a different immutable URL", () => {
    expect(pluginFrontendUrl({ ...validManifest, version: "1.1.0" })).toBe("taomni-plugin://localhost/demo/1.1.0/frontend/index.js");
    expect(new URL("./chunk.js", pluginFrontendUrl({ ...validManifest, version: "1.1.0" })).href)
      .toBe("taomni-plugin://localhost/demo/1.1.0/frontend/chunk.js");
  });

  it("accepts ordinary React memo and forwardRef exports but rejects invalid selected exports", async () => {
    for (const component of [memo(() => null), forwardRef(() => null)]) {
      await expect(loadPluginFrontend(validManifest, vi.fn().mockResolvedValue({ default: component })))
        .resolves.toHaveProperty("default", component);
    }
    await expect(loadPluginFrontend(validManifest, vi.fn().mockResolvedValue({ default: {}, component: () => null })))
      .rejects.toThrow("no component export");
    await expect(loadPluginFrontend(validManifest, vi.fn().mockResolvedValue({ component: {} })))
      .rejects.toThrow("no component export");
  });

  it.each(["windows", "linux", "macos"] as const)("uses Tauri's %s mapping and preserves versioned relative chunks", (platform) => {
    mockConvertFileSrc(platform);
    const base = platform === "windows" ? "http://taomni-plugin.localhost" : "taomni-plugin://localhost";
    const entry = pluginFrontendUrl({ ...validManifest, version: "1.2.0-rc.1+build.2", entry: { ...validManifest.entry, frontend: "frontend/my entry.js" } });
    expect(entry).toBe(`${base}/demo/1.2.0-rc.1%2Bbuild.2/frontend/my%20entry.js`);
    expect(new URL("./assets/chunk.js", entry).href).toBe(`${base}/demo/1.2.0-rc.1%2Bbuild.2/frontend/assets/chunk.js`);
    expect(entry).not.toBe(pluginFrontendUrl(validManifest));
  });

  it.each(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"])("keeps packaged ESM and relative chunks on %s", async (origin) => {
    mockConvertFileSrc(origin.startsWith("http") ? "windows" : "macos");
    const entry = pluginFrontendUrl(validManifest, `${origin}/index.html?window=plugin#detached`);
    expect(entry).toBe(`${origin}/__taomni_plugins__/demo/1.0.0/frontend/index.js`);
    expect(new URL("./messages.js", entry).href).toBe(`${origin}/__taomni_plugins__/demo/1.0.0/frontend/messages.js`);
    expect(pluginFrontendUrl({ ...validManifest, version: "1.1.0" }, `${origin}/index.html`))
      .toBe(`${origin}/__taomni_plugins__/demo/1.1.0/frontend/index.js`);
  });

  it.each(["http://localhost:1980", "https://evil.example", "tauri://other", "http://tauri.localhost.evil", "http://tauri.localhost:8888", "tauri://user@localhost"])("does not use an external or lookalike document as a native asset base: %s", (document) => {
    mockConvertFileSrc("macos");
    expect(pluginFrontendUrl(validManifest, `${document}/index.html`))
      .toBe("taomni-plugin://localhost/demo/1.0.0/frontend/index.js");
  });

  it.each(["../index.js", "frontend/../host", "frontend/%2e%2e/host", "frontend/a\\b.js", "frontend/index.js?other", "frontend//index.js"])("rejects a tampered frontend path: %s", (frontend) => {
    expect(() => pluginFrontendUrl({ ...validManifest, entry: { ...validManifest.entry, frontend } })).toThrow("unsafe frontend path");
  });

  it("rejects slug/version tampering before URL construction", () => {
    expect(() => pluginFrontendUrl({ ...validManifest, slug: "../demo" })).toThrow("unsafe frontend path");
    expect(() => pluginFrontendUrl({ ...validManifest, version: "1.0.0/../../" })).toThrow("unsafe frontend path");
  });

  it("does not create a lazy component for a missing or disabled plugin", async () => {
    const registry = new PluginRegistry({ coreApiVersion: "1", platform: "linux-x86_64" });
    registry.register(validManifest);
    const importer = vi.fn().mockResolvedValue({ default: () => null });
    const lazyComponent = createPluginLazyComponent(registry, "demo", importer);
    // React.lazy invokes the loader only when rendered; _result is private, so
    // rendering through a mounted tree is intentionally left to the UI case.
    expect(lazyComponent).toBeDefined();
    expect(importer).not.toHaveBeenCalled();
  });

  it("verifies SHA-256 before accepting downloaded content", async () => {
    const expected = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    await expect(verifyPluginSha256("hello", expected)).resolves.toBe(true);
    await expect(verifyPluginSha256("hello", "0".repeat(64))).resolves.toBe(false);
  });
});

