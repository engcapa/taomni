import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

import { isTauriRuntime } from "./runtime";

let permissionChecked = false;
let permissionGranted = false;

async function ensurePermission(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  if (permissionChecked) return permissionGranted;
  permissionChecked = true;
  try {
    permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      const result = await requestPermission();
      permissionGranted = result === "granted";
    }
  } catch {
    permissionGranted = false;
  }
  return permissionGranted;
}

/** Show a desktop notification for a new LanChat message. No-op in the browser
 *  preview or when notification permission is denied. */
export async function notifyLanMessage(title: string, body: string): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    if (!(await ensurePermission())) return;
    sendNotification({ title, body });
  } catch {
    /* notifications are best-effort */
  }
}
