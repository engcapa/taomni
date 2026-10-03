// Screenshot hotkey state shared by the title-bar button tooltip, the
// Settings panel and the app-local fallback handler.
//
// The OS-global chord is registered by the Rust backend. When that fails
// (chord owned by another app, Wayland, browser preview) the same chord is
// still handled while a Taomni window is focused.

import { useEffect } from "react";
import { create } from "zustand";
import { getAppPlatform, isTauriRuntime } from "./runtime";
import {
  eventMatchesAccelerator,
  formatAccelerator,
  isScreenshotOverlayWindow,
  isScreenshotPinWindow,
  isScreenshotRecorderWindow,
  isScreenshotScrollWindow,
  isScreenshotBoundaryWindow,
  openScreenshotOverlay,
  setShortcut,
  shortcutStatus,
  type ShortcutStatus,
} from "./screenshot";

const IS_MAC = getAppPlatform() === "macos";

/** Mirrors `DEFAULT_SHORTCUT` in src-tauri/src/screenshot/shortcut.rs. */
export const DEFAULT_SCREENSHOT_SHORTCUT = IS_MAC ? "Control+Super+A" : "Control+Alt+A";

const BROWSER_STATUS: ShortcutStatus = {
  accelerator: DEFAULT_SCREENSHOT_SHORTCUT,
  defaultAccelerator: DEFAULT_SCREENSHOT_SHORTCUT,
  enabled: true,
  registered: false,
  error: null,
};

interface ShortcutStore {
  status: ShortcutStatus;
  loaded: boolean;
  refresh: () => Promise<void>;
  /** `null` = default, `""` = disabled. Throws the backend error. */
  update: (accelerator: string | null) => Promise<ShortcutStatus>;
}

export const useScreenshotShortcutStore = create<ShortcutStore>((set) => ({
  status: BROWSER_STATUS,
  loaded: false,
  refresh: async () => {
    if (!isTauriRuntime()) {
      set({ loaded: true });
      return;
    }
    try {
      set({ status: await shortcutStatus(), loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  update: async (accelerator) => {
    if (!isTauriRuntime()) {
      const next = {
        ...BROWSER_STATUS,
        accelerator: accelerator === null ? DEFAULT_SCREENSHOT_SHORTCUT : accelerator,
        enabled: accelerator !== "",
      };
      set({ status: next });
      return next;
    }
    const next = await setShortcut(accelerator);
    set({ status: next });
    return next;
  },
}));

/** Human label of the configured chord ("" when disabled). */
export function screenshotShortcutLabel(status: ShortcutStatus): string {
  return status.enabled ? formatAccelerator(status.accelerator, IS_MAC) : "";
}

/**
 * Handle the configured chord while a Taomni window is focused. Skipped
 * when the OS-global registration succeeded in the native app (the global
 * handler fires for focused windows too), in editable fields, and inside
 * the screenshot tool's own windows.
 */
export function useScreenshotAppShortcut(): void {
  const status = useScreenshotShortcutStore((s) => s.status);
  const refresh = useScreenshotShortcutStore((s) => s.refresh);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!status.enabled || (isTauriRuntime() && status.registered)) return;
    if (isScreenshotOverlayWindow() || isScreenshotRecorderWindow() || isScreenshotPinWindow() || isScreenshotScrollWindow() || isScreenshotBoundaryWindow()) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (!eventMatchesAccelerator(event, status.accelerator)) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], .cm-editor, .xterm")) return;
      event.preventDefault();
      void openScreenshotOverlay().catch((err) => {
        console.error("[screenshot] app shortcut failed", err);
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [status]);
}
