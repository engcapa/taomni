import { describe, expect, it } from "vitest";
import { PLUGIN_CORE_API_VERSION, PluginRegistry, validatePluginManifest } from "./pluginRegistry";

const manifest = (overrides: Record<string, unknown> = {}) => ({
  id: "taomni-plugin-rdp-client",
  slug: "rdp-client",
  name: "RDP Client",
  version: "1.2.3",
  coreApiVersion: PLUGIN_CORE_API_VERSION,
  kind: "remote-client",
  status: "stable",
  platforms: ["linux-x86_64"],
  entry: { host: "bin/taomni-plugin-rdp-client", frontend: "frontend/index.js", protocol: 1 },
  tabs: [{ kind: "rdp", title: "RDP" }],
  commands: ["connect", "disconnect"],
  permissions: ["session.read", "network.egress"],
  dataDir: "plugins/rdp-client",
  backupPaths: ["plugins/rdp-client/data.db"],
  legacyTables: ["rdp_certificate_pins"],
  vaultFixedKeys: [],
  snapshot: "rpc",
  ...overrides,
});

describe("plugin manifest validation", () => {
  it("accepts a signed module shape and rejects paths that escape its directory", () => {
    expect(validatePluginManifest(manifest(), { coreApiVersion: "1", platform: "linux-x86_64" }).ok).toBe(true);
    const result = validatePluginManifest(manifest({ entry: { frontend: "../index.js", protocol: 1 } }));
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("entry");
  });

  it("rejects incompatible API versions, unsupported permissions, and platform misses", () => {
    const result = validatePluginManifest(manifest({ coreApiVersion: "2", permissions: ["not-a-permission"] }), {
      coreApiVersion: "1",
      platform: "darwin-aarch64",
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("incompatible"),
      expect.stringContaining("platform"),
      expect.stringContaining("permissions"),
    ]));
  });
});

describe("PluginRegistry", () => {
  it("keeps invalid manifests visible as disabled records and only resolves enabled tabs", () => {
    const registry = new PluginRegistry({ coreApiVersion: "1", platform: "linux-x86_64" });
    const invalid = registry.register(manifest({ slug: "../escape", id: "bad" }));
    expect(invalid.lifecycle).toBe("disabled");
    expect(invalid.reason).toBeTruthy();
    registry.register(manifest());
    expect(registry.resolveTab("rdp")).toBeUndefined();
    registry.setEnabled("rdp-client", true);
    expect(registry.resolveTab("rdp")?.plugin.slug).toBe("rdp-client");
    registry.setEnabled("rdp-client", false);
    expect(registry.resolveTab("rdp")).toBeUndefined();
  });
});

