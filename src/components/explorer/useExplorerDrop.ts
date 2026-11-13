import { useEffect, useRef, useState, type RefObject } from "react";
import { useCustomDropTarget } from "../../lib/customDnD";
import { NATIVE_FILE_DROP_EVENT, type NativeFileDropDetail } from "../../lib/osFileDrop";
import { getAppPlatform } from "../../lib/runtime";
import type { ExplorerOperations } from "./useExplorerOperations";

export const EXPLORER_DRAG_MIME = "taomni/explorer-files";
export interface ExplorerDragPayload { paths: string[] }
export function useExplorerDrop(root: RefObject<HTMLDivElement | null>, operations: ExplorerOperations) {
  const [dropPath, setDropPath] = useState<string | null>(null);
  const modifier = useRef(false);
  const copyKey = getAppPlatform() === "macos" ? "altKey" : "ctrlKey";
  useEffect(() => {
    const update = (event: KeyboardEvent | PointerEvent | DragEvent) => { modifier.current = event[copyKey]; };
    const reset = () => { modifier.current = false; setDropPath(null); };
    window.addEventListener("keydown", update, true);
    window.addEventListener("keyup", update, true);
    window.addEventListener("pointermove", update, true);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", update, true);
      window.removeEventListener("keyup", update, true);
      window.removeEventListener("pointermove", update, true);
      window.removeEventListener("blur", reset);
    };
  }, [copyKey]);
  const targetPath = (target: Element | null) => {
    const targetElement = target?.closest<HTMLElement>("[data-explorer-drop]");
    return targetElement && root.current?.contains(targetElement) ? targetElement.dataset.explorerDrop ?? null : null;
  };
  useCustomDropTarget(root, {
    accepts: (data) => data.mime === EXPLORER_DRAG_MIME && !!data.payload && !operations.busy,
    onDragOver: (detail) => setDropPath(targetPath(detail.target)),
    onDragLeave: () => setDropPath(null),
    onDrop: (detail) => {
      const destination = targetPath(detail.target);
      setDropPath(null);
      const payload = detail.data.payload as ExplorerDragPayload;
      if (destination && Array.isArray(payload.paths)) void operations.drop(payload.paths, destination, modifier.current);
    },
  });
  useEffect(() => {
    const handle = (event: Event) => {
      const detail = (event as CustomEvent<NativeFileDropDetail>).detail;
      if (!detail?.paths?.length) return;
      const destination = targetPath(document.elementFromPoint(detail.clientX, detail.clientY));
      if (destination) void operations.drop(detail.paths, destination, modifier.current);
    };
    window.addEventListener(NATIVE_FILE_DROP_EVENT, handle);
    return () => window.removeEventListener(NATIVE_FILE_DROP_EVENT, handle);
  });
  return dropPath;
}
