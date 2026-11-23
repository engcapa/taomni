import { beforeEach, describe, expect, it } from "vitest";
import { invokePlugin } from "./plugin";
import { setCrashRegressionModuleProfile } from "../modulePreview";
import type { PluginRecord } from "../../lib/pluginRegistry";
import frozenRoster from "../../../src-tauri/plugins/legacy-upgrade.json";
import type { LegacyInstallSnapshot, MigrationExecutionResult } from "../../lib/ipc/plugin";

beforeEach(() => localStorage.clear());

describe("browser plugin boundary", () => {
  it("rejects unverified archive and directory installs while retaining an empty registry", async () => {
    for (const command of ["plugin_install_archive", "plugin_install_staged"]) {
      await expect(invokePlugin(command)).rejects.toThrow("cannot verify native signatures");
    }
    expect(await invokePlugin("plugin_list")).toEqual([]);
    expect(await invokePlugin("plugin_refresh")).toEqual([]);
  });

  it("never returns a fake success for unsupported lifecycle commands", async () => {
    await expect(invokePlugin("plugin_set_enabled")).rejects.toThrow("requires the desktop app");
    expect(await invokePlugin("plugin_cancel_request")).toBe(false);
  });

  it("loads the complete crash-regression roster and clears it in the core profile", async () => {
    const manifests = import.meta.glob<{ default: { slug: string; version: string } }>(
      "../../../src-tauri/plugins/*/module.json", { eager: true },
    );
    const versions = Object.fromEntries(frozenRoster.map((id) => {
      const slug = id.replace("taomni-plugin-", "");
      return [slug, manifests[`../../../src-tauri/plugins/${slug}/module.json`].default.version];
    }));
    setCrashRegressionModuleProfile(versions);
    const records = await invokePlugin<PluginRecord[]>("plugin_list");
    expect(records).toHaveLength(frozenRoster.length);
    expect(Object.fromEntries(records.map(({ manifest }) => [manifest.slug, manifest.version]))).toEqual(versions);
    expect(records.every(({ lifecycle }) => lifecycle === "enabled")).toBe(true);
    setCrashRegressionModuleProfile({});
    expect(await invokePlugin("plugin_list")).toEqual([]);
  });
});

it("keeps ordinary browser preflight empty", async () => {
  const snapshot = await invokePlugin<LegacyInstallSnapshot>("plugin_migration_inspect");
  expect(snapshot.candidates).toEqual([]);
  expect(snapshot.retained_paths).toEqual([]);
});

it("keeps the explicit VNC browser model pending on every attempt without claiming native activation", async () => {
  const snapshot: LegacyInstallSnapshot = {
    from_version: "0.5.x", database_path: "preview/taomni.db", database_tables: ["sessions"],
    candidates: [{ item: "vnc-sessions", plugin_slug: "vnc-client", evidence: ["taomni.db"] }],
    source_fingerprints: {}, retained_paths: ["preview/lanchat.db"], vault: null,
  };
  const input = JSON.stringify(snapshot);
  localStorage.setItem("taomni.preview.module-upgrade.v1", input);
  expect(await invokePlugin("plugin_migration_inspect")).toEqual(snapshot);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await invokePlugin<MigrationExecutionResult>("plugin_migration_execute");
    expect(result).toMatchObject({ status: "pending", committed: [], pending: ["vnc-sessions"] });
    expect(result.pending_reason).toContain("Browser preview");
    expect(localStorage.getItem("taomni.preview.module-upgrade.v1")).toBe(input);
    expect(localStorage.getItem("taomni.preview.modules.v1")).toBeNull();
  }
});
