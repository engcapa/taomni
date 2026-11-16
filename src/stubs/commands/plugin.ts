/** Preview has no native signature verifier or installed plugin registry.
 * Mutations must reject explicitly; returning undefined would fake success. */
import { invokeModulePreview } from "../modulePreview";
import { invokeModuleDownloadPreview } from "../moduleDownloadPreview";
import type { ModuleNetworkConfig } from "../../lib/ipc/plugin";

export async function invokePlugin<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  switch (command) {
    case "plugin_download_list":
    case "plugin_download_cancel":
    case "plugin_download_resume":
    case "plugin_download_forget":
      return invokeModuleDownloadPreview(command, args) as T;
    case "plugin_network_get": {
      if (localStorage.getItem("taomni.preview.module-network-fail-once") === "true") {
        localStorage.removeItem("taomni.preview.module-network-fail-once");
        throw new Error("Preview fixture: connection settings could not be read");
      }
      const saved = localStorage.getItem("taomni.preview.module-network.v1");
      return (saved ? JSON.parse(saved) : { mode: "app", custom: { enabled: false, mode: "manual", session_id: "", kind: "http", host: "", port: 3128, username: "", password_ref: "" } }) as T;
    }
    case "plugin_network_save": {
      const config = args?.config as ModuleNetworkConfig;
      if (!config || !["app", "custom", "none"].includes(config.mode)) throw new Error("Invalid module network settings");
      if (config.custom.password_ref && !config.custom.password_ref.startsWith("vault:")) throw new Error("Proxy password must use the credential vault");
      localStorage.setItem("taomni.preview.module-network.v1", JSON.stringify(config));
      return undefined as T;
    }
    case "plugin_list":
    case "plugin_refresh":
      return invokeModulePreview(command, args) as T;
    case "plugin_migration_inspect":
      return {
        from_version: "0.5.x", database_path: null, database_tables: [], candidates: [],
        source_fingerprints: {}, retained_paths: [], vault: null,
      } as T;
    case "plugin_migration_execute":
      return { status: "complete", committed: [], skipped: [], pending: [], pending_reason: null } as T;
    case "plugin_install_archive":
    case "plugin_install_staged":
      throw new Error("Unverified module package: browser preview cannot verify native signatures.");
    case "plugin_cancel_request":
      return false as T;
    default:
      return invokeModulePreview(command, args) as T;
  }
}
