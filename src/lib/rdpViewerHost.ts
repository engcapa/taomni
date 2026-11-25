import { getCurrentWindow as tauriWindow, type Window } from "@tauri-apps/api/window";
import { confirmAppDialog } from "./appDialogs";
import { readFiles, readText, writeFiles, writeText } from "./clipboard";
import { t, useT } from "./i18n";
import { rdpConnect, rdpDisconnect, rdpTrustCertificate } from "./rdp";
import { isTauriRuntime } from "./runtime";
import {
  FT_BUTTON_ACTIVE_OVERRIDE, FT_BUTTON_STYLE, FT_ICON_BUTTON_STYLE, FT_SEPARATOR_STYLE,
} from "../components/floating-toolbar/floatingToolbarStyles";
import { ScreenshotMenuButton } from "../components/screenshot/ScreenshotMenuButton";
import { TabActions } from "../components/tabbar/TabActionSlot";

export {
  confirmAppDialog, readFiles, readText, writeFiles, writeText, t, useT, isTauriRuntime,
  rdpConnect, rdpDisconnect, rdpTrustCertificate, ScreenshotMenuButton, TabActions,
  FT_BUTTON_ACTIVE_OVERRIDE, FT_BUTTON_STYLE, FT_ICON_BUTTON_STYLE, FT_SEPARATOR_STYLE,
};

type ViewerWindow = Pick<Window, "isFullscreen" | "isMaximized" | "minimize" | "unmaximize" | "setFullscreen">;

export function getCurrentWindow(): ViewerWindow {
  return tauriWindow();
}

const host = Object.freeze({
  confirmAppDialog, readFiles, readText, writeFiles, writeText, t, useT, isTauriRuntime, getCurrentWindow,
  rdpConnect, rdpDisconnect, rdpTrustCertificate, ScreenshotMenuButton, TabActions,
  FT_BUTTON_ACTIVE_OVERRIDE, FT_BUTTON_STYLE, FT_ICON_BUTTON_STYLE, FT_SEPARATOR_STYLE,
});

export function installRdpViewerHost() {
  Object.defineProperty(globalThis, "__taomniRdpViewerHost", { value: host });
}
