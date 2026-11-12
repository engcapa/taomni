import { useEffect, useRef } from "react";
import type { CodeWorkspaceRootInfo } from "../../../types";
import { NATIVE_FILE_DROP_EVENT, droppedFilePaths, isOsFileDrag, type NativeFileDropDetail } from "../../../lib/osFileDrop";
import { NATIVE_FILE_DRAG_EVENT, type NativeFileDragDetail } from "../../../lib/nativeFileDrag";

export interface WorkspaceImportTarget {
  rootId: string;
  path: string;
}
export type ImportDroppedPaths = (target: WorkspaceImportTarget, paths: string[]) => Promise<void>;

/** A file row is not a directory: never climb past it or fall back to an
 * active/default root. The same DOM contract covers compact and search rows. */
export function projectTreeDropTarget(host: HTMLElement, element: Element | null, roots: readonly CodeWorkspaceRootInfo[]): { row: HTMLElement; target: WorkspaceImportTarget } | null {
  const row = element?.closest<HTMLElement>("[data-tree-kind]");
  if (!row || !host.contains(row)) return null;
  const kind = row.dataset.treeKind;
  if (kind !== "root" && kind !== "dir") return null;
  const rootId = row.dataset.rootId;
  if (!rootId || !roots.some((root) => root.id === rootId)) return null;
  const path = kind === "root" ? "" : row.dataset.path;
  if (path === undefined) return null;
  return { row, target: { rootId, path } };
}

/** Own native subscriptions and browser DOM events independently of row
 * virtualization. Hover paints only a row attribute, not a workspace update. */
export function useProjectTreeFileDrop(roots: CodeWorkspaceRootInfo[], onImportPaths?: ImportDroppedPaths) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !onImportPaths) return;
    let highlighted: HTMLElement | null = null;
    const highlight = (row: HTMLElement | null) => {
      if (highlighted === row) return;
      highlighted?.removeAttribute("data-drop-target");
      highlighted = row;
      highlighted?.setAttribute("data-drop-target", "true");
    };
    const clear = () => highlight(null);
    const hit = (element: Element | null) => projectTreeDropTarget(host, element, roots);
    const atPoint = (x: number, y: number) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return hit(document.elementFromPoint(x, y));
    };
    const submit = (target: WorkspaceImportTarget, paths: string[]) => {
      const local = [...new Set(paths.filter((path) => /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path)))];
      if (local.length) void onImportPaths(target, local);
    };
    const hover = (event: DragEvent) => {
      if (!isOsFileDrag(event.dataTransfer)) { clear(); return; }
      const match = hit(event.target instanceof Element ? event.target : null);
      highlight(match?.row ?? null);
      if (event.dataTransfer) event.dataTransfer.dropEffect = match ? "copy" : "none";
      if (match) event.preventDefault();
    };
    const drop = (event: DragEvent) => {
      clear();
      if (!isOsFileDrag(event.dataTransfer)) return;
      const match = hit(event.target instanceof Element ? event.target : null);
      if (!match) return;
      event.preventDefault();
      event.stopPropagation();
      submit(match.target, droppedFilePaths(event.dataTransfer));
    };
    const leave = (event: DragEvent) => {
      if (!(event.relatedTarget instanceof Node) || !highlighted?.contains(event.relatedTarget)) clear();
    };
    const nativeHover = (event: Event) => {
      const detail = (event as CustomEvent<NativeFileDragDetail>).detail;
      highlight(detail.type === "leave" ? null : atPoint(detail.clientX, detail.clientY)?.row ?? null);
    };
    const nativeDrop = (event: Event) => {
      const detail = (event as CustomEvent<NativeFileDropDetail>).detail;
      clear();
      const match = atPoint(detail.clientX, detail.clientY);
      if (match) submit(match.target, detail.paths);
    };
    host.addEventListener("dragenter", hover);
    host.addEventListener("dragover", hover);
    host.addEventListener("dragleave", leave);
    host.addEventListener("drop", drop);
    window.addEventListener(NATIVE_FILE_DRAG_EVENT, nativeHover);
    window.addEventListener(NATIVE_FILE_DROP_EVENT, nativeDrop);
    window.addEventListener("blur", clear);
    window.addEventListener("dragend", clear);
    window.addEventListener("scroll", clear, true);
    return () => {
      clear();
      host.removeEventListener("dragenter", hover);
      host.removeEventListener("dragover", hover);
      host.removeEventListener("dragleave", leave);
      host.removeEventListener("drop", drop);
      window.removeEventListener(NATIVE_FILE_DRAG_EVENT, nativeHover);
      window.removeEventListener(NATIVE_FILE_DROP_EVENT, nativeDrop);
      window.removeEventListener("blur", clear);
      window.removeEventListener("dragend", clear);
      window.removeEventListener("scroll", clear, true);
    };
  }, [roots, onImportPaths]);
  return hostRef;
}
