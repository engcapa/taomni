import { useEffect } from "react";
import { isOsFileDrag } from "./osFileDrop";

/**
 * Renderer guards every Taomni window installs, whatever it renders.
 *
 * In production builds (the shipped binary, not `pnpm dev` / `tauri dev`),
 * suppress the WebView's native right-click menu and its reload shortcuts.
 * On WebView2/WKWebView that menu exposes "Reload", which reloads the whole
 * webview and tears down every live terminal / SFTP / AI session (or the
 * capture session of a screenshot overlay); there is no real navigation in
 * this SPA, so a reload is always destructive. Editable fields keep their
 * native Cut/Copy/Paste menu (which never contains Reload), and the app's own
 * custom context menus call preventDefault themselves, so capture-phase here
 * leaves them intact (preventDefault does not stop propagation to React
 * handlers). F5 and Ctrl/Cmd+R (with their Shift hard-reload variants) are
 * only preventDefault-ed, never stopPropagation-ed: F5 still runs a query in
 * the SQL editor, Ctrl+R still reaches the terminal (bash reverse-search) and
 * RDP/VNC viewers forward the keys to the remote.
 *
 * In every build, an OS file dragged onto a window must never navigate the
 * webview away from the app.
 */
export function useWebviewGuards(): void {
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    const suppressNativeMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) {
        return;
      }
      event.preventDefault();
    };
    window.addEventListener("contextmenu", suppressNativeMenu, { capture: true });
    return () => window.removeEventListener("contextmenu", suppressNativeMenu, { capture: true });
  }, []);

  useEffect(() => {
    if (!import.meta.env.PROD) return;
    const blockReloadKeys = (event: KeyboardEvent) => {
      const isReload =
        event.key === "F5" ||
        ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "r");
      if (isReload) event.preventDefault();
    };
    window.addEventListener("keydown", blockReloadKeys, { capture: true });
    return () => window.removeEventListener("keydown", blockReloadKeys, { capture: true });
  }, []);

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
}
