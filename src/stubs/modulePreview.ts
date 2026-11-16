import type { PluginManifest, PluginRecord } from "../lib/pluginRegistry";

/** Explicit browser-only fixture model. Never verifies or installs an archive. */
export const MODULE_PREVIEW_KEY = "taomni.preview.modules.v1";
export const previewHelloManifest: PluginManifest = {
  id: "taomni-plugin-hello-plugin", slug: "hello-plugin", name: "Hello Plugin", version: "0.1.0",
  coreApiVersion: "1", kind: "collaboration", status: "provisional",
  platforms: ["windows-x86_64", "darwin-aarch64", "darwin-x86_64", "linux-x86_64"],
  entry: { host: "taomni-hello-plugin", frontend: "frontend/index.js", protocol: 1 },
  tabs: [{ kind: "hello-plugin", title: "Hello Plugin" }],
  commands: ["hello/ping", "hello/crash", "hello/hang", "plugin/enable", "plugin/disable", "hello/write", "hello/read", "backup/prepare", "backup/snapshot", "backup/release"],
  permissions: [], dataDir: "plugins/hello-plugin", backupPaths: ["plugins/hello-plugin/data"],
  legacyTables: [], vaultFixedKeys: [], snapshot: "rpc",
};

interface PreviewState { lifecycle: PluginRecord["lifecycle"]; values: string[] }

function read(): PreviewState | null {
  try {
    const value = JSON.parse(localStorage.getItem(MODULE_PREVIEW_KEY) ?? "null");
    if (!["installed", "enabled", "disabled", "uninstalled"].includes(value?.lifecycle)
      || !Array.isArray(value.values) || value.values.some((entry: unknown) => typeof entry !== "string")) return null;
    return value;
  } catch { return null; }
}

function record(state: PreviewState): PluginRecord {
  return { slug: "hello-plugin", manifest: previewHelloManifest, lifecycle: state.lifecycle, dataRetained: state.values.length > 0 };
}

export function invokeModulePreview(command: string, args?: Record<string, unknown>): unknown {
  const state = read();
  if (command === "plugin_list" || command === "plugin_refresh") return state ? [record(state)] : [];
  if (!state || args?.slug !== "hello-plugin") throw new Error(`Module operation requires the desktop app: ${command}`);
  if (command === "plugin_set_enabled" && state.lifecycle !== "uninstalled") {
    state.lifecycle = args.enabled === true ? "enabled" : "disabled";
  } else if (command === "plugin_uninstall") {
    state.lifecycle = "uninstalled";
    if (args.deleteData === true) state.values = [];
  } else if (command === "plugin_invoke" && state.lifecycle === "enabled") {
    if (args.command === "hello/ping") return { pluginId: previewHelloManifest.id, version: "0.1.0", enabled: true };
    if (args.command === "hello/read") return { values: [...state.values] };
    const value = (args.payload as { value?: unknown } | undefined)?.value;
    if (args.command !== "hello/write" || typeof value !== "string" || new TextEncoder().encode(value).length > 4096) {
      throw new Error("Invalid preview module request");
    }
    state.values.push(value);
    localStorage.setItem(MODULE_PREVIEW_KEY, JSON.stringify(state));
    return { values: [...state.values] };
  } else throw new Error(`Module operation is unavailable: ${command}`);
  localStorage.setItem(MODULE_PREVIEW_KEY, JSON.stringify(state));
  return record(state);
}
