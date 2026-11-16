/** Preview has no native signature verifier or installed plugin registry.
 * Mutations must reject explicitly; returning undefined would fake success. */
import { invokeModulePreview } from "../modulePreview";

export async function invokePlugin<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  switch (command) {
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
