import { useRef, useState, useEffect, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriRuntime } from "../../../lib/runtime";
import { type FullScreenRestore, restoreWindowAfterFullScreen } from "./fullScreen";


export interface UseVncFullScreenContext {
  detachedWindowControls: { onReattach: () => void; onToggleOsFullscreen: () => void; osFullscreen: boolean; } | undefined;
  visible: boolean;
}

export function useVncFullScreen(context: UseVncFullScreenContext) {
  const { detachedWindowControls, visible } = context;

  const [screenFullScreen, setScreenFullScreen] = useState(false);
  const fullScreenRestoreRef = useRef<FullScreenRestore | null>(null);


  const canFullScreen = Boolean(detachedWindowControls)
    || isTauriRuntime()
    || (typeof document !== "undefined" && typeof document.documentElement?.requestFullscreen === "function");

  // VNC-VIEW-002 / DEC-VNC-18: screen-level full screen is the OS window in
  // full screen plus this panel covering the whole WebView. The Fullscreen
  // API is not used, so Esc and every other key still reach the remote.
  const setWindowFullScreen = useCallback(async (next: boolean) => {
    if (!isTauriRuntime()) {
      setScreenFullScreen(next);
      return;
    }
    try {
      const w = getCurrentWindow();
      if (next) {
        const restore = {
          maximized: await w.isMaximized(),
          osFullscreen: await w.isFullscreen(),
          resizable: await w.isResizable(),
        };
        fullScreenRestoreRef.current = restore;
        // A maximized borderless window keeps a work-area-sized surface on
        // Windows unless it leaves the maximized state first.
        if (restore.maximized) await w.unmaximize();
        // Tauri resizes undecorated windows through a child window over the
        // window edges; in full screen it would take the pointer at the top
        // edge (the toolbar hot zone). A non-resizable window has none.
        if (restore.resizable) await w.setResizable(false);
        if (!restore.osFullscreen) await w.setFullscreen(true);
      } else {
        const restore = fullScreenRestoreRef.current;
        fullScreenRestoreRef.current = null;
        await restoreWindowAfterFullScreen(w, restore);
      }
    } catch {
      // Window API unavailable: the in-WebView cover still applies.
    }
    setScreenFullScreen(next);
  }, []);

  const fullScreen = detachedWindowControls ? detachedWindowControls.osFullscreen : screenFullScreen;

  const toggleFullScreen = useCallback(() => {
    if (detachedWindowControls) {
      detachedWindowControls.onToggleOsFullscreen();
      return;
    }
    void setWindowFullScreen(!screenFullScreen);
  }, [detachedWindowControls, screenFullScreen, setWindowFullScreen]);

  // Leaving the tab or closing it restores the window.
  useEffect(() => {
    if (!screenFullScreen || visible) return;
    void setWindowFullScreen(false);
  }, [screenFullScreen, visible, setWindowFullScreen]);
  useEffect(() => () => {
    if (fullScreenRestoreRef.current && isTauriRuntime()) {
      const restore = fullScreenRestoreRef.current;
      void restoreWindowAfterFullScreen(getCurrentWindow(), restore).catch(() => { });
    }
  }, []);
  return { fullScreen, canFullScreen, toggleFullScreen, screenFullScreen, setScreenFullScreen, fullScreenRestoreRef };
}
