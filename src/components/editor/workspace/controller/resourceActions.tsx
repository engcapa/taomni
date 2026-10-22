import { workspaceApplyResourceOperation } from "../../../../lib/editor/workspace";
import { type LspWorkspaceEditOperation } from "../../../../lib/editor/lsp";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import { SaveTransactionRegistry } from "../saveCommit";
import { transformWorkspaceResourceExpandedDirKeys, transformWorkspaceResourceFileKey, transformWorkspaceResourceFileRef, transformWorkspaceResourceTreeSelection, type WorkspaceResourceUiChange } from "../workspaceResourceState";
import { writeWorkspaceBookmarks, type WorkspaceBookmark } from "../todoBookmarks";
import type { CodeWorkspaceFileRef, CodeWorkspaceLooseFileInfo, CodeWorkspaceRootInfo } from "../../../../types";
import { type LspFileState, type OpenFileState, type TreeSelection, fileKey, fileRefUnder, fileMeta, normalizeFsPath, relativePathWithinRoot } from "../codeWorkspaceModel";
import type { EditorRevealTarget } from "../EditorGroup";



export interface ApplyLspResourceOperationUnlockedContext {
  flushPendingEditorText: () => void;
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  saveTransactionRegistryRef: import("react").RefObject<SaveTransactionRegistry>;
  workspaceInstanceId: string;
  closeLspDocument: (file: OpenFileState) => void;
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  reconcileNavigationFileReferences: (transform: (ref: CodeWorkspaceFileRef) => CodeWorkspaceFileRef | null) => void;
  setExpandedDirs: (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  setSelected: (selection: TreeSelection | null) => void;
  replaceWorkspaceFileState: (nextOpenFiles: Record<string, OpenFileState>, nextLspFiles: Record<string, LspFileState>, keyChanges: Record<string, string | null>) => void;
  setRevealTarget: import("react").Dispatch<import("react").SetStateAction<EditorRevealTarget | null>>;
  bookmarksRef: import("react").RefObject<WorkspaceBookmark[]>;
  looseFilesRef: import("react").RefObject<CodeWorkspaceLooseFileInfo[]>;
  replaceBookmarks: (next: WorkspaceBookmark[]) => void;
  syncLspDocument: (file: OpenFileState, mode: "open" | "change") => Promise<void>;
  notifyWorkspacePathGitChanged: (rootId: string, path: string) => void;
}


export function createApplyLspResourceOperationUnlocked(controllerContext: ApplyLspResourceOperationUnlockedContext) {
  return async (
    operation: Exclude<LspWorkspaceEditOperation, { kind: "text" }>,
  ) => {
    controllerContext.flushPendingEditorText();
    const targetForPath = (absolutePath: string | null) => {
      if (!absolutePath) throw new Error("Language server resource URI is not a local file");
      const normalized = normalizeFsPath(absolutePath);
      const candidates = controllerContext.rootsRef.current.flatMap((root) => {
        const path = relativePathWithinRoot(root.path, normalized);
        return path !== null && path !== ""
          ? [{ root, path, rootLength: normalizeFsPath(root.path).length }]
          : [];
      }).sort((left, right) => right.rootLength - left.rootLength);
      const target = candidates[0];
      if (target) return { root: target.root, path: target.path };
      throw new Error(`Language server resource is outside the workspace: ${normalized}`);
    };
    const initialOpenFiles = controllerContext.openFilesRef.current;
    const initialFiles = Object.values(initialOpenFiles);
    const closeFiles = (files: OpenFileState[]) => {
      for (const file of files) {
        // Rename/DeleteFile invalidate in-flight save owners for the removed buffers.
        controllerContext.saveTransactionRegistryRef.current.discardFile(
          controllerContext.workspaceInstanceId,
          file.key,
          `Buffer ${file.subtitle} was removed by a workspace resource operation`,
        );
        controllerContext.closeLspDocument(file);
      }
    };
    const bookmarkRef = (key: string): CodeWorkspaceFileRef | null => {
      for (const root of controllerContext.rootsRef.current) {
        const prefix = `root:${root.id}:`;
        if (key.startsWith(prefix)) {
          return { kind: "root", rootId: root.id, path: key.slice(prefix.length) };
        }
      }
      return null;
    };
    const commitResourceState = (
      change: WorkspaceResourceUiChange,
      previousOpenFiles: Record<string, OpenFileState>,
      nextOpenFiles: Record<string, OpenFileState>,
      reopenedFiles: OpenFileState[],
      options: { preserveRemovedBookmarks?: boolean } = {},
    ) => {
      const keyChanges: Record<string, string | null> = {};
      for (const key of Object.keys(previousOpenFiles)) {
        const nextKey = transformWorkspaceResourceFileKey(key, change);
        if (nextKey !== key) keyChanges[key] = nextKey;
      }
      const nextLspFiles: Record<string, LspFileState> = {};
      for (const [key, state] of Object.entries(controllerContext.lspFilesRef.current)) {
        if (transformWorkspaceResourceFileKey(key, change) === key && key in nextOpenFiles) {
          nextLspFiles[key] = state;
        }
      }
      controllerContext.reconcileNavigationFileReferences((ref) => transformWorkspaceResourceFileRef(ref, change));
      const currentUi = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), controllerContext.workspaceInstanceId);
      controllerContext.setExpandedDirs((current) => transformWorkspaceResourceExpandedDirKeys(current, change));
      controllerContext.setSelected(transformWorkspaceResourceTreeSelection(currentUi.treeSelection, change));
      controllerContext.replaceWorkspaceFileState(nextOpenFiles, nextLspFiles, keyChanges);
      controllerContext.setRevealTarget(null);
      const currentBookmarks = controllerContext.bookmarksRef.current;
      let bookmarksChanged = false;
      const nextBookmarks = currentBookmarks.flatMap((bookmark) => {
        const nextKey = transformWorkspaceResourceFileKey(bookmark.fileKey, change);
        if (!nextKey) {
          if (options.preserveRemovedBookmarks || bookmark.state === "missing") return [bookmark];
          bookmarksChanged = true;
          return [{ ...bookmark, state: "missing" as const }];
        }
        if (nextKey === bookmark.fileKey) return [bookmark];
        bookmarksChanged = true;
        const ref = bookmarkRef(bookmark.fileKey);
        const nextRef = ref ? transformWorkspaceResourceFileRef(ref, change) : null;
        const pathLabel = nextRef
          ? fileMeta(nextRef, controllerContext.rootsRef.current, controllerContext.looseFilesRef.current).subtitle
          : bookmark.pathLabel;
        return [{ ...bookmark, fileKey: nextKey, pathLabel, state: "current" as const }];
      });
      if (bookmarksChanged) {
        writeWorkspaceBookmarks(controllerContext.workspaceInstanceId, nextBookmarks);
        controllerContext.replaceBookmarks(nextBookmarks);
      }
      for (const file of reopenedFiles) void controllerContext.syncLspDocument(file, "open");
    };

    if (operation.kind === "create") {
      const target = targetForPath(operation.path);
      const existingBefore = initialFiles.filter((file) => (
        fileRefUnder(file.ref, target.root.id, target.path)
      ));
      if (
        operation.overwrite
        && existingBefore.some((file) => file.dirty)
      ) {
        throw new Error("CreateFile would overwrite an unsaved editor buffer");
      }
      const result = await workspaceApplyResourceOperation(target.root.path, {
        kind: "create",
        path: target.path,
        overwrite: operation.overwrite,
        ignoreIfExists: operation.ignoreIfExists,
      });
      if (result.ignored) return;
      controllerContext.notifyWorkspacePathGitChanged(target.root.id, target.path);
      if (!operation.overwrite) return;
      controllerContext.flushPendingEditorText();
      const currentOpenFiles = controllerContext.openFilesRef.current;
      const existing = Object.values(currentOpenFiles).filter((file) => (
        fileRefUnder(file.ref, target.root.id, target.path)
      ));
      closeFiles(existing);
      const change: WorkspaceResourceUiChange = {
        kind: "remove",
        target: { rootId: target.root.id, path: target.path },
      };
      const nextOpenFiles = Object.fromEntries(Object.entries(currentOpenFiles).filter(([key]) => (
        transformWorkspaceResourceFileKey(key, change) !== null
      )));
      commitResourceState(change, currentOpenFiles, nextOpenFiles, [], {
        preserveRemovedBookmarks: true,
      });
      return;
    }

    if (operation.kind === "delete") {
      const target = targetForPath(operation.path);
      const affectedBefore = initialFiles.filter((file) => (
        fileRefUnder(file.ref, target.root.id, target.path)
      ));
      if (affectedBefore.some((file) => file.dirty)) {
        throw new Error("DeleteFile would discard an unsaved editor buffer");
      }
      const result = await workspaceApplyResourceOperation(target.root.path, {
        kind: "delete",
        path: target.path,
        recursive: operation.recursive,
        ignoreIfNotExists: operation.ignoreIfNotExists,
      });
      if (result.ignored) return;
      controllerContext.flushPendingEditorText();
      const currentOpenFiles = controllerContext.openFilesRef.current;
      const affected = Object.values(currentOpenFiles).filter((file) => (
        fileRefUnder(file.ref, target.root.id, target.path)
      ));
      closeFiles(affected);
      const change: WorkspaceResourceUiChange = {
        kind: "remove",
        target: { rootId: target.root.id, path: target.path },
      };
      const nextOpenFiles = Object.fromEntries(Object.entries(currentOpenFiles).filter(([key]) => (
        transformWorkspaceResourceFileKey(key, change) !== null
      )));
      commitResourceState(change, currentOpenFiles, nextOpenFiles, []);
      controllerContext.notifyWorkspacePathGitChanged(target.root.id, target.path);
      return;
    }

    const source = targetForPath(operation.oldPath);
    const destination = targetForPath(operation.newPath);
    const destinationFilesBefore = initialFiles.filter((file) => (
      fileRefUnder(file.ref, destination.root.id, destination.path)
      && !fileRefUnder(file.ref, source.root.id, source.path)
    ));
    if (
      operation.overwrite
      && destinationFilesBefore.some((file) => file.dirty)
    ) {
      throw new Error("RenameFile would overwrite an unsaved editor buffer");
    }
    const result = await workspaceApplyResourceOperation(source.root.path, {
      kind: "rename",
      fromPath: source.path,
      toPath: destination.path,
      toRepoRoot: destination.root.path,
      overwrite: operation.overwrite,
      ignoreIfExists: operation.ignoreIfExists,
    });
    if (result.ignored) return;
    controllerContext.flushPendingEditorText();
    const currentOpenFiles = controllerContext.openFilesRef.current;
    const currentFiles = Object.values(currentOpenFiles);
    const sourceFiles = currentFiles.filter((file) => (
      fileRefUnder(file.ref, source.root.id, source.path)
    ));
    const destinationFiles = currentFiles.filter((file) => (
      fileRefUnder(file.ref, destination.root.id, destination.path)
      && !fileRefUnder(file.ref, source.root.id, source.path)
    ));
    closeFiles([...sourceFiles, ...destinationFiles]);
    const change: WorkspaceResourceUiChange = {
      kind: "move",
      source: { rootId: source.root.id, path: source.path },
      destination: { rootId: destination.root.id, path: destination.path },
    };
    const remappedFiles: Record<string, OpenFileState> = {};
    const reopenedFiles: OpenFileState[] = [];
    for (const [key, file] of Object.entries(currentOpenFiles)) {
      const ref = transformWorkspaceResourceFileRef(file.ref, change);
      if (!ref) continue;
      const nextKey = fileKey(ref);
      if (nextKey === key) {
        remappedFiles[key] = file;
        continue;
      }
      const meta = fileMeta(ref, controllerContext.rootsRef.current, controllerContext.looseFilesRef.current);
      const nextFile = {
        ...file,
        ref,
        key: nextKey,
        path: meta.path,
        title: meta.title,
        subtitle: meta.subtitle,
        languagePath: meta.languagePath,
      };
      remappedFiles[nextKey] = nextFile;
      reopenedFiles.push(nextFile);
    }
    commitResourceState(change, currentOpenFiles, remappedFiles, reopenedFiles);
    controllerContext.notifyWorkspacePathGitChanged(source.root.id, source.path);
    controllerContext.notifyWorkspacePathGitChanged(destination.root.id, destination.path);
  };
}
