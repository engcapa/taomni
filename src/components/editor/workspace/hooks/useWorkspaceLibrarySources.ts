import { useCallback } from "react";
import { lspDownloadSources, type LspDocumentDescriptor, type LspLocation } from "../../../../lib/editor/lsp";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore, type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceFileRef, CodeWorkspaceLooseFileInfo, CodeWorkspaceRootInfo } from "../../../../types";
import {
  type LibraryBufferInfo,
  type OpenFileState,
  errorMessage,
  isExternalHref,
  makeLibraryFile,
  resolveLooseMarkdownLink,
  resolveRootMarkdownLink,
} from "../codeWorkspaceModel";
import type { EditorRevealTarget } from "../EditorGroup";
import { createOpenLspLocation } from "../controller/navigationActions";
import { type LspLocationOpenOptions } from "../controller/model";


export interface UseWorkspaceLibrarySourcesContext {
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  openFile: (ref: CodeWorkspaceFileRef, options?: { preview?: boolean; groupId?: EditorGroupId; activate?: boolean; restoring?: boolean; isCurrent?: () => boolean; }) => Promise<{ canonicalFileKey: string; groupId: string; error: string | null; } | null>;
  addLooseFilePath: (path: string) => Promise<void>;
  revealNonceRef: import("react").RefObject<number>;
  setRevealTarget: import("react").Dispatch<import("react").SetStateAction<EditorRevealTarget | null>>;
  libraryBuffersRef: import("react").RefObject<Record<string, LibraryBufferInfo>>;
  suppressNextHistoryRecord: () => void;
  setOpenFiles: (updater: Record<string, OpenFileState> | ((prev: Record<string, OpenFileState>) => Record<string, OpenFileState>)) => void;
  workspaceInstanceId: string;
  updateEditorGroup: (groupId: EditorGroupId, updater: import("../../../../stores/codeWorkspaceStore").CodeWorkspaceEditorGroupState | ((prev: import("../../../../stores/codeWorkspaceStore").CodeWorkspaceEditorGroupState) => import("../../../../stores/codeWorkspaceStore").CodeWorkspaceEditorGroupState)) => void;
  activateEditorGroup: (groupId: EditorGroupId) => void;
  recordNavigationLocation: (ref: CodeWorkspaceFileRef, position: import("../useWorkspaceNavigation").WorkspaceNavPosition, options?: { replaceSameFile?: boolean; }) => void;
  setStatusMessage: (message: string) => void;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  downloadingSourcesKeys: string[];
  setDownloadingSourcesKeys: import("react").Dispatch<import("react").SetStateAction<string[]>>;
  lspDescriptorForPath: (rootPath: string | null, filePath: string, documentUri?: string | null) => LspDocumentDescriptor;
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  setLooseFiles: import("react").Dispatch<import("react").SetStateAction<CodeWorkspaceLooseFileInfo[]>>;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  updateLspStatusForFile: (file: OpenFileState, status: import("../../../../lib/editor/lsp").LspDocumentStatus) => void;
}

export function useWorkspaceLibrarySources(context: UseWorkspaceLibrarySourcesContext) {
  const {
    activeFile,
    openFile,
    addLooseFilePath,
    revealNonceRef,
    setRevealTarget,
    libraryBuffersRef,
    suppressNextHistoryRecord,
    setOpenFiles,
    workspaceInstanceId,
    updateEditorGroup,
    activateEditorGroup,
    recordNavigationLocation,
    setStatusMessage,
    openFilesRef,
    downloadingSourcesKeys,
    setDownloadingSourcesKeys,
    lspDescriptorForPath,
    rootsRef,
    setLooseFiles,
    lspDescriptorForFile,
    updateLspStatusForFile,
  } = context;

  const openMarkdownHref = useCallback(
    (href: string) => {
      if (!activeFile || isExternalHref(href)) return false;
      const target = href.split("#", 1)[0].split("?", 1)[0];
      if (!target) return false;
      if (activeFile.ref.kind === "root") {
        const path = resolveRootMarkdownLink(activeFile.ref.path, target);
        void openFile({ kind: "root", rootId: activeFile.ref.rootId, path });
        return true;
      }
      const path = resolveLooseMarkdownLink(activeFile.ref.path, target);
      void addLooseFilePath(path);
      return true;
    },
    [activeFile, addLooseFilePath, openFile],
  );

  const revealEditorLocation = useCallback((key: string, range: LspLocation["range"]) => {
    revealNonceRef.current += 1;
    setRevealTarget({
      key,
      line: range.start.line,
      character: range.start.character,
      nonce: revealNonceRef.current,
    });
  }, []);

  /**
   * Open a language-server library source (JDK class, dependency JAR) as a
   * read-only buffer. Nothing is read from or written to disk, and the buffer is
   * not registered as a loose workspace file — it only exists while open (plus in
   * the library registry so history can reopen it).
   */
  const openLibraryBuffer = useCallback(async (
    info: LibraryBufferInfo,
    text: string,
    range: LspLocation["range"],
    options: LspLocationOpenOptions = {},
  ) => {
    if (options.isCurrent && !options.isCurrent()) return false;
    const file = makeLibraryFile(info, text);
    const ref = file.ref;
    const key = file.key;
    libraryBuffersRef.current[key] = info;
    suppressNextHistoryRecord();
    setOpenFiles((current) => ({ ...current, [key]: file }));
    const currentUi = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    const groupId = options.groupId ?? currentUi.activeEditorGroupId;
    updateEditorGroup(groupId, (group) => {
      const alreadyOpen = group.openOrder.includes(key);
      let nextOrder = group.openOrder;
      let previewKey = group.previewKey;
      if (!alreadyOpen) {
        if (options.preview && previewKey && previewKey !== key && !group.pinnedKeys.includes(previewKey)) {
          nextOrder = nextOrder.filter((entry) => entry !== previewKey);
        }
        nextOrder = [...nextOrder, key];
      }
      if (options.preview) {
        previewKey = group.pinnedKeys.includes(key) ? null : key;
      } else if (previewKey === key) {
        previewKey = null;
      }
      return { ...group, openOrder: nextOrder, activeKey: key, previewKey };
    });
    if (groupId !== currentUi.activeEditorGroupId) activateEditorGroup(groupId);
    if (options.isCurrent && !options.isCurrent()) return false;
    revealEditorLocation(key, range);
    if (options.isCurrent && !options.isCurrent()) return false;
    const position = {
      line: range.start.line,
      character: range.start.character,
    };
    if (options.onRevealed) {
      options.onRevealed(ref, position);
    } else if (options.recordHistory !== false) {
      recordNavigationLocation(ref, position, { replaceSameFile: false });
    }
    setStatusMessage(`Opened ${file.subtitle} (read-only)`);
    return true;
  }, [
    activateEditorGroup,
    recordNavigationLocation,
    revealEditorLocation,
    setStatusMessage,
    suppressNextHistoryRecord,
    updateEditorGroup,
    workspaceInstanceId,
  ]);

  /**
   * IDEA-style on-demand "Download sources" for a decompiled library buffer:
   * ask jdtls to fetch the sources JAR, then swap the buffer's decompiled bytecode
   * for the attached source in place (keeping the same tab / caret).
   */
  const downloadLibrarySources = useCallback(async (key: string) => {
    const info = libraryBuffersRef.current[key];
    const file = openFilesRef.current[key];
    if (!info || !file?.library) return;
    if (downloadingSourcesKeys.includes(key)) return;
    setDownloadingSourcesKeys((current) => [...current, key]);
    setStatusMessage(`Downloading sources for ${info.title}…`);
    try {
      const descriptor = lspDescriptorForPath(info.originRootPath, info.originFilePath);
      const result = await lspDownloadSources(descriptor, info.uri);
      if (!openFilesRef.current[key]) return; // tab closed mid-download
      if (result.attached && !result.decompiled) {
        const nextInfo: LibraryBufferInfo = { ...info, decompiled: false };
        libraryBuffersRef.current[key] = nextInfo;
        // Preserve caret/scroll: only the text + decompiled flag change.
        setOpenFiles((current) => {
          const existing = current[key];
          if (!existing) return current;
          const rebuilt = makeLibraryFile(nextInfo, result.text);
          return { ...current, [key]: { ...rebuilt, key: existing.key } };
        });
        setStatusMessage(`Attached sources for ${info.title}`);
      } else {
        setStatusMessage(result.message ?? `No sources published for ${info.title}`);
      }
    } catch (err) {
      setStatusMessage(errorMessage(err));
    } finally {
      setDownloadingSourcesKeys((current) => current.filter((entry) => entry !== key));
    }
  }, [downloadingSourcesKeys, lspDescriptorForPath, setStatusMessage]);

  const openLspLocation = useCallback(
    createOpenLspLocation({
      rootsRef,
      suppressNextHistoryRecord,
      openFile,
      openFilesRef,
      revealEditorLocation,
      recordNavigationLocation,
      setLooseFiles,
      setStatusMessage,
      activeFile,
      lspDescriptorForFile,
      updateLspStatusForFile,
      openLibraryBuffer,
    }),
    [
      activeFile,
      lspDescriptorForFile,
      openFile,
      openLibraryBuffer,
      recordNavigationLocation,
      revealEditorLocation,
      setStatusMessage,
      suppressNextHistoryRecord,
      updateLspStatusForFile,
    ],
  );
  return { openLspLocation, revealEditorLocation, openLibraryBuffer, downloadLibrarySources, openMarkdownHref };
}
