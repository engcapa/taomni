import { useCallback, useEffect, useRef, type RefObject } from "react";
import { readFilesResult, writeFiles } from "../../../lib/clipboard";
import { subscribeClipboardWrites } from "../../../lib/clipboardOwnership";
import { lspWorkspaceDidFileOperation, lspWorkspaceWillFileOperation, type LspWorkspaceEditOperation, type LspWorkspaceFileOperation } from "../../../lib/editor/lsp";
import type { CodeWorkspaceRootInfo } from "../../../types";
import { absoluteWorkspacePath, basename, errorMessage, parentPath } from "./codeWorkspaceModel";
import type { ImportDroppedPaths, WorkspaceImportTarget } from "./useProjectTreeFileDrop";

interface Dependencies {
  workspaceId: string;
  rootsRef: RefObject<CodeWorkspaceRootInfo[]>;
  importPaths: ImportDroppedPaths;
  applyResourceOperation: (operation: Exclude<LspWorkspaceEditOperation, { kind: "text" }>) => Promise<void>;
  loadDir: (rootId: string, path: string) => Promise<void>;
  loadFlatFiles: (rootId: string, force?: boolean) => Promise<void>;
  onStatus: (message: string) => void;
}
interface InternalCut { rootId: string; rootPath: string; path: string; isDirectory: boolean }

/** File Copy/Paste uses the current system file list, never a stale private
 * copy. Cut remains app-local and expires on focus loss or another Copy. */
export function useWorkspaceTreeClipboard(dependencies: Dependencies) {
  const latest = useRef(dependencies);
  latest.current = dependencies;
  const cut = useRef<InternalCut | null>(null);
  const owner = useRef<object | null>(null);
  const writeQueue = useRef(Promise.resolve());
  const pasting = useRef<object | null>(null);
  useEffect(() => {
    owner.current = {};
    pasting.current = null;
    const clear = () => { cut.current = null; };
    const unsubscribeWrites = subscribeClipboardWrites(clear);
    window.addEventListener("blur", clear);
    window.addEventListener("copy", clear, true);
    window.addEventListener("cut", clear, true);
    return () => {
      owner.current = null;
      clear();
      unsubscribeWrites();
      window.removeEventListener("blur", clear);
      window.removeEventListener("copy", clear, true);
      window.removeEventListener("cut", clear, true);
    };
  }, [dependencies.workspaceId]);

  const stageTreeClipboard = useCallback(async (mode: "copy" | "cut", rootId: string, path: string, isDirectory = false) => {
    const context = latest.current;
    const token = owner.current;
    const root = context.rootsRef.current.find((entry) => entry.id === rootId);
    if (!root || !token) return;
    cut.current = null;
    if (mode === "cut") {
      if (!path) { context.onStatus("The workspace root cannot be cut"); return; }
      cut.current = { rootId, rootPath: root.path, path, isDirectory };
      context.onStatus("Cut for moving within this workspace; leaving the app cancels the cut");
      return;
    }
    const source = absoluteWorkspacePath(root, path);
    const write = writeQueue.current.then(async () => {
      if (owner.current !== token) return;
      await writeFiles([source]);
      if (owner.current === token) latest.current.onStatus(`Copied file reference: ${source}`);
    });
    writeQueue.current = write.catch(() => {});
    try { await write; } catch (error) {
      if (owner.current === token) latest.current.onStatus(`Copy failed: ${errorMessage(error)}`);
    }
  }, []);

  const pasteTreeClipboard = useCallback(async (target: WorkspaceImportTarget) => {
    const context = latest.current;
    const token = owner.current;
    const root = context.rootsRef.current.find((entry) => entry.id === target.rootId);
    if (!root || !token || pasting.current) return;
    const current = () => owner.current === token
      && latest.current.workspaceId === context.workspaceId
      && latest.current.rootsRef.current.some((entry) => entry.id === root.id && entry.path === root.path);
    const clip = cut.current;
    const request = {};
    pasting.current = request;
    try {
      if (clip) {
        if (clip.rootId !== root.id || clip.rootPath !== root.path) {
          context.onStatus("Cross-root cut/paste is not supported");
          return;
        }
        const destination = target.path ? `${target.path}/${basename(clip.path)}` : basename(clip.path);
        const operation: LspWorkspaceFileOperation = { kind: "rename", files: [{
          oldPath: absoluteWorkspacePath(root, clip.path), newPath: absoluteWorkspacePath(root, destination), isDirectory: clip.isDirectory,
        }] };
        await lspWorkspaceWillFileOperation(context.workspaceId, operation);
        if (!current() || cut.current !== clip) return;
        await context.applyResourceOperation({
          kind: "rename", oldUri: "", oldPath: absoluteWorkspacePath(root, clip.path), newUri: "", newPath: absoluteWorkspacePath(root, destination),
          overwrite: false, ignoreIfExists: false, annotationId: null,
        });
        if (cut.current === clip) cut.current = null;
        let warning = "";
        try { await lspWorkspaceDidFileOperation(context.workspaceId, operation); }
        catch (error) { warning = `; language server notification failed: ${errorMessage(error)}`; }
        if (!current()) return;
        await Promise.all([context.loadDir(root.id, parentPath(clip.path)), context.loadDir(root.id, target.path), context.loadFlatFiles(root.id, true)]);
        if (current()) context.onStatus(`Moved to ${destination}${warning}`);
        return;
      }
      // Wait for an immediately preceding Copy, but do not cache its paths:
      // another application may have replaced the system clipboard meanwhile.
      await writeQueue.current;
      if (!current()) return;
      const files = await readFilesResult();
      if (!current()) return;
      if (!files.ok) { context.onStatus(`Paste failed: ${files.message}`); return; }
      if (!files.paths.length) { context.onStatus("No files on the system clipboard"); return; }
      await context.importPaths(target, files.paths);
    } catch (error) {
      if (current()) context.onStatus(`Paste failed: ${errorMessage(error)}`);
    } finally { if (pasting.current === request) pasting.current = null; }
  }, []);

  // Availability cannot be inferred from private clipboard state: the system
  // may change at any moment. Read on explicit Paste instead of polling it.
  const canPasteTreeClipboard = useCallback(() => latest.current.rootsRef.current.length > 0, []);
  return { stageTreeClipboard, canPasteTreeClipboard, pasteTreeClipboard };
}
