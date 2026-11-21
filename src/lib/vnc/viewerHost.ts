import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, type Window } from "@tauri-apps/api/window";

import { getAppPlatform, isTauriRuntime } from "../runtime";
import { readMultiFormat, readNativeTextResult, readText, writeMultiFormat, writeText } from "../clipboard";
import { t, useT } from "../i18n";
import { vncCancelConnect, vncConnect, vncDisconnect } from "./connection";
import { useContextMenu } from "../../components/ContextMenu";
import { useFocusReturn } from "../../components/editor/workspace/useFocusReturn";
import { FT_BUTTON_STYLE, FT_ICON_BUTTON_STYLE, FT_SEPARATOR_STYLE } from "../../components/floating-toolbar/floatingToolbarStyles";
import { ScreenshotMenuButton } from "../../components/screenshot/ScreenshotMenuButton";
import { TabActions } from "../../components/tabbar/TabActionSlot";

export type { MenuItem } from "../../components/ContextMenu";
export {
  getAppPlatform, isTauriRuntime, readMultiFormat, readNativeTextResult, readText, writeMultiFormat, writeText,
  t, useT, vncCancelConnect, vncConnect, vncDisconnect, useContextMenu, useFocusReturn,
  FT_BUTTON_STYLE, FT_ICON_BUTTON_STYLE, FT_SEPARATOR_STYLE, ScreenshotMenuButton, TabActions,
};

type ViewerWindow = Pick<Window, "isMaximized" | "isFullscreen" | "isResizable" | "maximize" | "unmaximize" | "setResizable" | "setFullscreen">;

export function getViewerWindow(): ViewerWindow {
  return getCurrentWindow();
}

export function setVncSpecialKeyCapture(enabled: boolean): Promise<void> {
  return invoke("vnc_set_special_key_capture", { enabled });
}

export function listenVncSpecialKey(handler: (key: { code: string; down: boolean }) => void) {
  return listen<{ code: string; down: boolean }>("vnc-special-key", ({ payload }) => handler(payload));
}

const host = Object.freeze({
  getAppPlatform, isTauriRuntime, readMultiFormat, readNativeTextResult, readText, writeMultiFormat, writeText,
  t, useT, vncCancelConnect, vncConnect, vncDisconnect, useContextMenu, useFocusReturn,
  FT_BUTTON_STYLE, FT_ICON_BUTTON_STYLE, FT_SEPARATOR_STYLE, ScreenshotMenuButton, TabActions,
  getViewerWindow, setVncSpecialKeyCapture, listenVncSpecialKey,
});

/** Shared UI primitives and core-owned OS operations for the official VNC viewer. */
export function installVncViewerHost() {
  Object.defineProperty(globalThis, "__taomniVncViewerHost", { value: host });
}
