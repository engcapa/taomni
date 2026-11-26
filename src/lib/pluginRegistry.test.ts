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
  backupPaths: ["plugins/rdp-client/data/data.db"],
  legacyTables: ["rdp_certificate_pins"],
  vaultFixedKeys: [],
  snapshot: "rpc",
  ...overrides,
});

describe("plugin manifest validation", () => {
  it("preserves document associations on renderer modules and rejects invalid suffixes", () => {
    const document = { fileKinds: ["excel"], extensions: ["xls", "xlsx"] };
    expect(validatePluginManifest(manifest({ document })).manifest?.document).toEqual(document);
    expect(validatePluginManifest(manifest()).manifest?.document).toBeUndefined();
    expect(validatePluginManifest(manifest({ document, entry: { host: "reader", protocol: 1 } })).ok).toBe(false);
    for (const extensions of [[], ["*.xls"], [".xlsx"], ["XLSX"], ["xls", "xls"], ["doc/x"], ["x".repeat(25)]]) {
      expect(validatePluginManifest(manifest({ document: { ...document, extensions } })).ok).toBe(false);
    }
  });

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

  it("confines data paths to their owner and preserves the default schema for older manifests", () => {
    expect(validatePluginManifest(manifest()).manifest?.dataSchemaVersion).toBe(1);
    expect(validatePluginManifest(manifest({ dataSchemaVersion: 7 })).manifest?.dataSchemaVersion).toBe(7);
    for (const path of ["vault.db", "plugins/other/data/mfa.db", "plugins/rdp-client/active.json",
      "plugins/rdp-client/data/../active.json", "plugins/rdp-client/data/CON.db",
      "plugins/rdp-client/data/a:stream", "plugins/rdp-client/data/a?b", "plugins/rdp-client/data/trailing."]) {
      expect(validatePluginManifest(manifest({ backupPaths: [path] })).ok, path).toBe(false);
    }
    expect(validatePluginManifest(manifest({ dataDir: "plugins/other" })).ok).toBe(false);
    expect(validatePluginManifest(manifest({ backupPaths: ["plugins/rdp-client/data/A.db", "plugins/rdp-client/data/a.db"] })).ok).toBe(false);
    for (const dataSchemaVersion of [0, -1, 1.5, 0x100000000, "1", null]) {
      expect(validatePluginManifest(manifest({ dataSchemaVersion })).ok).toBe(false);
    }
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

