import type { PluginManifest, PluginRecord } from "../lib/pluginRegistry";
import mailManifest from "../../src-tauri/plugins/mail/module.json";
import rdpManifest from "../../src-tauri/plugins/rdp-client/module.json";
import vncManifest from "../../src-tauri/plugins/vnc-client/module.json";

/** Explicit browser-only fixture model. Never verifies or installs an archive. */
export const MODULE_PREVIEW_KEY = "taomni.preview.modules.v1";
const VNC_PREVIEW_KEY = "taomni.preview.modules.vnc.v1";
const RDP_PREVIEW_KEY = "taomni.preview.modules.rdp.v1";
const MAIL_PREVIEW_KEY = "taomni.preview.modules.mail.v1";
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
const previewModules = [
  { manifest: vncManifest as PluginManifest, key: VNC_PREVIEW_KEY },
  { manifest: rdpManifest as PluginManifest, key: RDP_PREVIEW_KEY },
  { manifest: mailManifest as PluginManifest, key: MAIL_PREVIEW_KEY },
];

interface PreviewState { lifecycle: PluginRecord["lifecycle"]; values: string[]; version?: string; previousVersion?: string }

function readPreview(key: string): PreviewState | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!["installed", "enabled", "disabled", "uninstalled"].includes(value?.lifecycle)
      || !Array.isArray(value.values) || value.values.some((entry: unknown) => typeof entry !== "string")) return null;
    return value;
  } catch { return null; }
}

export function readModulePreview(): PreviewState | null {
  return readPreview(MODULE_PREVIEW_KEY);
}

export function previewModuleRecord(state: PreviewState, manifest = previewHelloManifest): PluginRecord {
  return {
    slug: manifest.slug, manifest: { ...manifest, version: state.version ?? manifest.version },
    lifecycle: state.lifecycle, previousVersion: state.previousVersion, dataRetained: state.values.length > 0,
  };
}

export function invokeModulePreview(command: string, args?: Record<string, unknown>): unknown {
  if (command === "plugin_list" || command === "plugin_refresh") {
    const hello = readModulePreview();
    return [
      ...(hello ? [previewModuleRecord(hello)] : []),
      ...previewModules.flatMap(({ manifest, key }) => {
        const state = readPreview(key);
        return state ? [previewModuleRecord(state, manifest)] : [];
      }),
    ];
  }
  const { manifest, key } = previewModules.find(({ manifest }) => manifest.slug === args?.slug)
    ?? { manifest: previewHelloManifest, key: MODULE_PREVIEW_KEY };
  const state = readPreview(key);
  if (!state || args?.slug !== manifest.slug) throw new Error(`Module operation requires the desktop app: ${command}`);
  if (command === "plugin_set_enabled" && state.lifecycle !== "uninstalled") {
    state.lifecycle = args.enabled === true ? "enabled" : "disabled";
  } else if (command === "plugin_uninstall") {
    state.lifecycle = "uninstalled";
    delete state.previousVersion;
    if (args.deleteData === true) state.values = [];
  } else if (command === "plugin_rollback" && state.lifecycle !== "uninstalled" && state.previousVersion && args.version === state.previousVersion) {
    [state.version, state.previousVersion] = [state.previousVersion, state.version];
  } else if (command === "plugin_invoke" && manifest === previewHelloManifest && state.lifecycle === "enabled") {
    if (args.command === "hello/ping") return { pluginId: previewHelloManifest.id, version: state.version ?? previewHelloManifest.version, enabled: true };
    if (args.command === "hello/read") return { values: [...state.values] };
    const value = (args.payload as { value?: unknown } | undefined)?.value;
    if (args.command !== "hello/write" || typeof value !== "string" || new TextEncoder().encode(value).length > 4096) {
      throw new Error("Invalid preview module request");
    }
    state.values.push(value);
    localStorage.setItem(key, JSON.stringify(state));
    return { values: [...state.values] };
  } else throw new Error(`Module operation is unavailable: ${command}`);
  localStorage.setItem(key, JSON.stringify(state));
  return previewModuleRecord(state, manifest);
}
