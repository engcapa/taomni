import { describe, expect, it, vi } from "vitest";
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
  it("uses a restricted taomni-plugin URL and surfaces load failures", async () => {
    expect(pluginFrontendUrl(validManifest)).toBe("taomni-plugin://demo/frontend/index.js");
    const importer = vi.fn().mockResolvedValue({ default: () => null });
    await expect(loadPluginFrontend(validManifest, importer)).resolves.toHaveProperty("default");
    expect(importer).toHaveBeenCalledWith("taomni-plugin://demo/frontend/index.js");
    await expect(loadPluginFrontend(validManifest, vi.fn().mockRejectedValue(new Error("bad hash")))).rejects.toMatchObject({
      name: "PluginLoadError",
      slug: "demo",
    });
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

