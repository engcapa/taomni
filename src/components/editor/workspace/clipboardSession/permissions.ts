import { probeClipboardCapabilities } from "../../../../lib/clipboard";
import { isTauriRuntime } from "../../../../lib/runtime";
import { type ClipboardPermissionAdapter, type ClipboardPermissionState, type NativeClipboardPermissionAdapterOptions } from "./model";

export function createWebClipboardPermissionAdapter(): ClipboardPermissionAdapter {
  return {
    async queryPermission(): Promise<ClipboardPermissionState> {
      if (typeof navigator === "undefined" || !navigator.permissions?.query) {
        return "unknown";
      }
      try {
        const status = await navigator.permissions.query({ name: "clipboard-read" as PermissionName });
        if (status.state === "granted") return "granted";
        if (status.state === "denied") return "denied";
        return "unknown";
      } catch {
        return "unknown";
      }
    },
    subscribe(listener: (permission: ClipboardPermissionState) => void): () => void {
      if (typeof navigator === "undefined" || !navigator.permissions?.query) {
        return () => { };
      }
      let active = true;
      let cleanup: (() => void) | null = null;
      navigator.permissions
        .query({ name: "clipboard-read" as PermissionName })
        .then((status) => {
          if (!active) return;
          const handler = () => {
            if (status.state === "granted") listener("granted");
            else if (status.state === "denied") listener("denied");
            else listener("unknown");
          };
          status.addEventListener("change", handler);
          cleanup = () => status.removeEventListener("change", handler);
        })
        .catch(() => { });
      return () => {
        active = false;
        cleanup?.();
      };
    },
  };
}

export function createNativeClipboardPermissionAdapter(
  options: NativeClipboardPermissionAdapterOptions = {},
): ClipboardPermissionAdapter {
  const runtimeAvailable = options.isRuntime ?? isTauriRuntime;
  const probeCapabilities = options.probeCapabilities ?? probeClipboardCapabilities;
  return {
    async queryPermission(): Promise<ClipboardPermissionState> {
      if (!runtimeAvailable()) return "unknown";
      try {
        // Backend availability is not an OS permission grant. The native
        // boundary has no permission-query command, so a successful probe
        // deliberately leaves permission unknown until a real read/write.
        await probeCapabilities();
      } catch {
        // Permission remains unknown when capability discovery itself fails.
      }
      return "unknown";
    },
  };
}

export function createDefaultClipboardPermissionAdapter(): ClipboardPermissionAdapter {
  if (isTauriRuntime()) {
    return createNativeClipboardPermissionAdapter();
  }
  return createWebClipboardPermissionAdapter();
}
