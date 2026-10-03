// Browser-preview stub for @tauri-apps/plugin-notification. Notifications are a
// desktop-only feature; in the Vite dev/browser preview these are no-ops so the
// LanChat module loads without bundling the real Tauri plugin.

export type Permission = "granted" | "denied" | "default";

export async function isPermissionGranted(): Promise<boolean> {
  return false;
}

export async function requestPermission(): Promise<Permission> {
  return "denied";
}

export function sendNotification(_options: unknown): void {
  /* no-op in browser preview */
}
