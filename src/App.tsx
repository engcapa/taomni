import { useEffect } from "react";
import { MainLayout } from "./layouts/MainLayout";
import {
  SftpDetachedWindow,
  detectDetachedSftpRoute,
} from "./components/filebrowser/SftpDetachedWindow";
import { useAppTheme } from "./lib/appTheme";
import { attachSftpSync } from "./lib/sftpSync";
import { sweepExpiredHandoffs } from "./components/filebrowser/SftpDetachedWindow";
import { dispatchNativeFileDrop, isOsFileDrag } from "./lib/osFileDrop";
import { isTauriRuntime } from "./lib/runtime";

function App() {
  const { mode, resolvedTheme } = useAppTheme();

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.appTheme = resolvedTheme;
    root.dataset.appThemeMode = mode;
    root.style.colorScheme = resolvedTheme;
  }, [mode, resolvedTheme]);

  // Mirror the transfer queue across same-origin windows so a user can see
  // the same uploads/downloads from both the main app and a detached SFTP
  // window. The cleanup tears the channel down on hot-reload too.
  useEffect(() => attachSftpSync(), []);
  useEffect(() => {
    const preventFileNavigation = (event: DragEvent) => {
      if (!isOsFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      if (event.type === "dragover" && event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
    };

    window.addEventListener("dragover", preventFileNavigation, { capture: true });
    window.addEventListener("drop", preventFileNavigation, { capture: true });
    return () => {
      window.removeEventListener("dragover", preventFileNavigation, { capture: true });
      window.removeEventListener("drop", preventFileNavigation, { capture: true });
    };
  }, []);
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

  const detachedSftpId = detectDetachedSftpRoute();
  if (detachedSftpId) {
    return <SftpDetachedWindow sessionId={detachedSftpId} />;
  }

  return <MainLayout />;
}

export default App;
