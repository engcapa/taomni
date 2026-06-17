import { isTauriRuntime } from "./runtime";

/** Open a native file picker and return the chosen absolute path (or null).
 *  Desktop-only: the Tauri dialog plugin is loaded lazily and only in the Tauri
 *  runtime, so the browser preview never bundles or invokes it. */
export async function pickFile(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({ multiple: false, directory: false });
    return typeof sel === "string" ? sel : null;
  } catch {
    return null;
  }
}

/** Open a native folder picker and return the chosen absolute path (or null). */
export async function pickDir(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({ multiple: false, directory: true });
    return typeof sel === "string" ? sel : null;
  } catch {
    return null;
  }
}
