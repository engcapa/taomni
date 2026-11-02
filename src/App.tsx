import { useEffect, useState, type ReactNode } from "react";
import { VoiceSettingsDialog } from "./components/voice/VoiceSettingsDialog";
import { MainLayout } from "./layouts/MainLayout";
import {
  SftpDetachedWindow,
  detectDetachedSftpRoute,
} from "./components/filebrowser/SftpDetachedWindow";
import DetachedSessionWindow from "./components/detached/DetachedSessionWindow";
import LanChatDetachedWindow from "./components/detached/LanChatDetachedWindow";
import { NotesDetachedWindow } from "./components/notes/NotesDetachedWindow";
import { ServersDialog } from "./components/servers/ServersDialog";
import { RdpServerApprovalBridge } from "./components/servers/RdpServerApprovalBridge";
import { detectDetachedRoute } from "./lib/detachedSession";
import {
  isScreenshotOverlayWindow,
  isScreenshotPinWindow,
  isScreenshotQaFixtureWindow,
  isScreenshotRecorderWindow,
  isScreenshotScrollWindow,
  isScreenshotBoundaryWindow,
} from "./lib/screenshot";
import { useScreenshotAppShortcut } from "./lib/screenshotShortcut";
import { ScreenshotOverlay } from "./components/screenshot/ScreenshotOverlay";
import { PinnedImage } from "./components/screenshot/PinnedImage";
import { PinToolsWindow } from "./components/screenshot/PinToolsWindow";
import { PinBoard } from "./components/screenshot/PinBoard";
import { RecorderBar } from "./components/screenshot/RecorderBar";
import { ScrollCaptureBar } from "./components/screenshot/ScrollCaptureBar";
import { ScreenshotQaFixture } from "./components/screenshot/ScreenshotQaFixture";
import { useAppTheme } from "./lib/appTheme";
import { applyCodeViewProfile, loadCodeViewProfile } from "./lib/codeViewProfile";
import { attachSftpSync } from "./lib/sftpSync";
import { sweepExpiredHandoffs } from "./components/filebrowser/SftpDetachedWindow";
import { dispatchNativeFileDrop } from "./lib/osFileDrop";
import { useWebviewGuards } from "./lib/webviewGuards";
import { isTauriRuntime, getAppPlatform } from "./lib/runtime";
import { subscribeUiAppearanceStorage, useAppStore } from "./stores/appStore";
import { AppDialogProvider } from "./lib/appDialogs";
import { VaultGateProvider } from "./lib/vaultGate";
import { StartupVaultUnlockGate } from "./components/vault/StartupVaultUnlockGate";
import { DEFAULT_TERMINAL_PROFILE } from "./lib/terminalProfile";

function App() {
  const { mode, resolvedTheme } = useAppTheme();
  const uiFontFamily = useAppStore((s) => s.uiFontFamily);
  const uiFontSize = useAppStore((s) => s.uiFontSize);
  // Track the URL hash so in-app navigations (e.g. the browser stub for
  // `screenshot_open_overlay`) re-render the route immediately.
  const [routeHash, setRouteHash] = useState(
    () => (typeof location !== "undefined" ? location.hash : ""),
  );
  useEffect(() => {
    const onHashChange = () => setRouteHash(location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // App-local fallback for the screenshot hotkey (see screenshotShortcut.ts).
  useScreenshotAppShortcut();

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.appTheme = resolvedTheme;
    root.dataset.appThemeMode = mode;
    root.style.colorScheme = resolvedTheme;
    root.dataset.appPlatform = getAppPlatform();
  }, [mode, resolvedTheme]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--taomni-ui-font-family", uiFontFamily);
    root.style.setProperty("--taomni-ui-font-size", `${uiFontSize}px`);
  }, [uiFontFamily, uiFontSize]);

  useEffect(() => subscribeUiAppearanceStorage(), []);

  useEffect(() => {
    applyCodeViewProfile(loadCodeViewProfile(), DEFAULT_TERMINAL_PROFILE, {
      resolvedAppTheme: resolvedTheme,
    });
  }, [resolvedTheme]);

  useWebviewGuards();

  // Mirror the transfer queue across same-origin windows so a user can see
  // the same uploads/downloads from both the main app and a detached SFTP
  // window. The cleanup tears the channel down on hot-reload too.
  useEffect(() => attachSftpSync(), []);
  useEffect(() => {
    if (!isTauriRuntime()) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void import("@tauri-apps/api/webview")
      .then(async ({ getCurrentWebview }) => {
        unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type !== "drop" || payload.paths.length === 0) return;

          const scale = window.devicePixelRatio || 1;
          dispatchNativeFileDrop({
            paths: payload.paths,
            clientX: payload.position.x / scale,
            clientY: payload.position.y / scale,
          });
        });
        if (disposed) unlisten?.();
      })
      .catch((err) => {
        console.warn("[drag-drop] native file drop listener unavailable", err);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  // Drop any stale credential handoffs left over from a previous run
  // (e.g. window.open denied, app crashed mid-launch). Defence-in-depth
  // for the localStorage-based handoff used by detached SFTP windows.
  useEffect(() => {
    sweepExpiredHandoffs();
  }, []);

  let content: ReactNode;
  let hostsRdpApprovals = false;
  // Screenshot tool overlay / recorder windows render standalone, outside the
  // main layout and the vault gate (they must work even while windows hide).
  // The URL-hash fallback also serves browser-mode QA: opening
  // `index.html#screenshot-overlay` renders the overlay in-page with stubbed
  // capture backends.
  const overlayHash = routeHash;
  if (isScreenshotBoundaryWindow() || overlayHash.startsWith("#screenshot-boundary")) {
    return <div data-testid="screenshot-recording-boundary" style={{ position: "fixed", inset: 0, background: "#ff4d4f", pointerEvents: "none" }} />;
  }
  if (isScreenshotScrollWindow() || overlayHash.startsWith("#screenshot-scroll")) return <ScrollCaptureBar />;
  if (
    isScreenshotOverlayWindow() ||
    overlayHash.startsWith("#screenshot-overlay")
  ) {
    // The overlay needs the app-dialog host for its save-path prompt.
    return (
      <AppDialogProvider>
        <ScreenshotOverlay />
      </AppDialogProvider>
    );
  }
  if (
    isScreenshotRecorderWindow() ||
    overlayHash.startsWith("#screenshot-recorder")
  ) {
    return (
      <AppDialogProvider>
        <RecorderBar />
      </AppDialogProvider>
    );
  }
  if (overlayHash.startsWith("#screenshot-pin-board")) return <PinBoard />;
  if (isTauriRuntime() && overlayHash.startsWith("#screenshot-pin-tools")) return <PinToolsWindow />;
  if (
    isScreenshotPinWindow() ||
    overlayHash.startsWith("#screenshot-pin")
  ) {
    return <AppDialogProvider><PinnedImage />{overlayHash.startsWith("#screenshot-pin-tools") && <PinToolsWindow />}</AppDialogProvider>;
  }
  if (isScreenshotQaFixtureWindow() || overlayHash.startsWith("#screenshot-qa-")) {
    return <ScreenshotQaFixture route={overlayHash.replace("#screenshot-qa-", "")} />;
  }
  const detachedSftpId = detectDetachedSftpRoute();
  if (detachedSftpId) {
    content = <SftpDetachedWindow sessionId={detachedSftpId} />;
  } else {
    const detachedRoute = detectDetachedRoute();
    if (detachedRoute?.kind === "lan-chat") {
      content = <LanChatDetachedWindow id={detachedRoute.id} />;
    } else if (detachedRoute?.kind === "notes") {
      content = <NotesDetachedWindow />;
    } else if (detachedRoute?.kind === "servers") {
      content = <ServersDialog />;
    } else {
      hostsRdpApprovals = !detachedRoute;
      content =
        detachedRoute && detachedRoute.kind !== "sftp"
          ? <DetachedSessionWindow kind={detachedRoute.kind} id={detachedRoute.id} />
          : <MainLayout />;
    }
  }

  return (
    <AppDialogProvider>
      {hostsRdpApprovals ? <RdpServerApprovalBridge /> : null}
      <VaultGateProvider>
        <StartupVaultUnlockGate>{content}<VoiceSettingsDialog /></StartupVaultUnlockGate>
      </VaultGateProvider>
    </AppDialogProvider>
  );
}

export default App;
