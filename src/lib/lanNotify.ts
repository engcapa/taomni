import { isTauriRuntime } from "./runtime";

let permissionChecked = false;
let permissionGranted = false;

/** Show a desktop notification for a new LanChat message. Desktop-only: the
 *  Tauri notification plugin is loaded lazily and only in the Tauri runtime, so
 *  the browser preview never bundles or invokes it. Best-effort. */
export async function notifyLanMessage(title: string, body: string): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const mod = await import("@tauri-apps/plugin-notification");
    if (!permissionChecked) {
      permissionChecked = true;
      permissionGranted = await mod.isPermissionGranted();
      if (!permissionGranted) {
        permissionGranted = (await mod.requestPermission()) === "granted";
      }
    }
    if (permissionGranted) mod.sendNotification({ title, body });
  } catch {
    /* notifications are best-effort */
  }
}
