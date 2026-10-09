// Screenshot hotkey state shared by the title-bar button tooltip, the
// Settings panel and the app-local fallback handler.
//
// The OS-global chord is registered by the Rust backend. When that fails
// (chord owned by another app, Wayland, browser preview) the same chord is
// still handled while a Taomni window is focused.

import { useCallback, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { create } from "zustand";
import { useAppDialogs, formatUnknownError } from "./appDialogs";
import { useT } from "./i18n";
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
  SCREENSHOT_OPEN_FAILED_EVENT,
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
  const dialogs = useAppDialogs();
  const t = useT();
  const status = useScreenshotShortcutStore((s) => s.status);
  const refresh = useScreenshotShortcutStore((s) => s.refresh);
  const showOpenError = useCallback((error: unknown) => dialogs.alert({
    title: t("screenshot.tooltip"),
    message: t("screenshot.openFailed", { error: formatUnknownError(error) }),
    tone: "error",
  }), [dialogs, t]);

  useEffect(() => {
    void refresh();
    if (!isTauriRuntime()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void getCurrentWindow().listen<ShortcutStatus>("screenshot://shortcut-status", ({ payload }) => {
      useScreenshotShortcutStore.setState({ status: payload, loaded: true });
    }).then((unlisten) => {
      if (disposed) unlisten();
      else { stop = unlisten; void refresh(); }
    }).catch((error) => console.error("[screenshot] shortcut status listener failed", error));
    return () => { disposed = true; stop?.(); };
  }, [refresh]);

  useEffect(() => {
    if (!isTauriRuntime() || getCurrentWindow().label.startsWith("screenshot-")) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().listen<string>(SCREENSHOT_OPEN_FAILED_EVENT, ({ payload }) => {
      void showOpenError(payload);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch((error) => console.error("[screenshot] error listener failed", error));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [showOpenError]);

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
        void showOpenError(err);
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [status, showOpenError]);
}
