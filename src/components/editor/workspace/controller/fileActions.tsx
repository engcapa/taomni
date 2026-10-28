import { workspaceReadFile, workspaceReadLooseFile } from "../../../../lib/editor/workspace";
import { lspReadUriContents, type LspDocumentDescriptor } from "../../../../lib/editor/lsp";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore, type CodeWorkspaceEditorGroupState, type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import { SaveTransactionRegistry } from "../saveCommit";
import { workspaceFileIdentity } from "../workspaceRecovery";
import { enforceTabPolicy, pushClosedTab, buildReopenTreeRoute, type ClosedTabEntry, type WorkspaceTabPolicyV3 } from "../workspaceTabPolicy";
import { findLeafNode } from "../recursiveLayoutTree";
import { confirmAppDialog } from "../../../../lib/appDialogs";
import { WorkspaceResourceRecoveryCoordinator, type ResourceCleanupHandlers, type ResourceCleanupOutcome } from "../workspaceResourceRecoveryCoordinator";
import type { CodeWorkspaceFileRef, CodeWorkspaceLooseFileInfo, CodeWorkspaceRootInfo } from "../../../../types";
import { type LibraryBufferInfo, type LspFileState, type MarkdownViewMode, type OpenFileState, errorMessage, fileKey, fileMeta, makeLibraryFile, makeLoadingFile, normalizeEditorText } from "../codeWorkspaceModel";
import { type PendingClosedFile, type PendingExternalFileEvent } from "./model";


export interface OpenFileContext {
  flushPendingEditorText: () => void;
  pendingClosedFilesRef: import("react").RefObject<Map<string, PendingClosedFile>>;
  workspaceInstanceId: string;
  updateEditorGroup: (groupId: EditorGroupId, updater: CodeWorkspaceEditorGroupState | ((prev: CodeWorkspaceEditorGroupState) => CodeWorkspaceEditorGroupState)) => void;
  tabPolicyRef: import("react").RefObject<WorkspaceTabPolicyV3>;
  activateEditorGroup: (groupId: EditorGroupId) => void;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  mruFileKeysRef: import("react").RefObject<string[]>;
  closeFileRef: import("react").RefObject<((key: string, groupId?: EditorGroupId, options?: { discard?: boolean; }) => Promise<void>) | null>;
  setStatusMessage: (message: string) => void;
  syncLspDocument: (file: OpenFileState, mode: "open" | "change") => Promise<void>;
  libraryBuffersRef: import("react").RefObject<Record<string, LibraryBufferInfo>>;
  setOpenFiles: (updater: Record<string, OpenFileState> | ((prev: Record<string, OpenFileState>) => Record<string, OpenFileState>)) => void;
  lspDescriptorForPath: (rootPath: string | null, filePath: string, documentUri?: string | null) => LspDocumentDescriptor;
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  looseFilesRef: import("react").RefObject<CodeWorkspaceLooseFileInfo[]>;
  findRoot: (rootId: string) => CodeWorkspaceRootInfo | null;
  restoreBookmarksForFileKey: (fileKeyValue: string, pathLabel?: string) => void;
}


export function createOpenFile(controllerContext: OpenFileContext) {
  return async (
      ref: CodeWorkspaceFileRef,
      options: {
        preview?: boolean;
        groupId?: EditorGroupId;
        activate?: boolean;
        restoring?: boolean;
        isCurrent?: () => boolean;
      } = {},
    ) => {
      const isCurrent = options.isCurrent ?? (() => true);
      if (!isCurrent()) {
        return null;
      }
      // Switching tabs before the input idle timer fires must never show an
      // older buffer snapshot in the newly activated editor.
      controllerContext.flushPendingEditorText();
      if (!isCurrent()) {
        return null;
      }
      const key = fileKey(ref);
      const pendingClosedFile = controllerContext.pendingClosedFilesRef.current.get(key);
      const currentUi = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), controllerContext.workspaceInstanceId);
      const groupId = options.groupId ?? currentUi.activeEditorGroupId;
      const shouldActivate = options.activate !== false;
      controllerContext.updateEditorGroup(groupId, (group) => {
        const alreadyOpen = group.openOrder.includes(key);
        let nextOrder = group.openOrder;
        let previewKey = group.previewKey;
        const effectivePreview = options.preview && controllerContext.tabPolicyRef.current.previewMode;
        if (!alreadyOpen) {
          if (effectivePreview && controllerContext.tabPolicyRef.current.reusePreview && previewKey && previewKey !== key && !group.pinnedKeys.includes(previewKey)) {
            nextOrder = nextOrder.filter((entry) => entry !== previewKey);
          }
          if (controllerContext.tabPolicyRef.current.openPosition === "after-active") {
            const activeIdx = nextOrder.indexOf(group.activeKey ?? "");
            if (activeIdx >= 0) {
              nextOrder = [
                ...nextOrder.slice(0, activeIdx + 1),
                key,
                ...nextOrder.slice(activeIdx + 1),
              ];
            } else {
              nextOrder = [...nextOrder, key];
            }
          } else {
            nextOrder = [...nextOrder, key];
          }
        }
        if (effectivePreview) {
          previewKey = group.pinnedKeys.includes(key) ? null : key;
        } else if (previewKey === key) {
          previewKey = null;
        }
        return { ...group, openOrder: nextOrder, activeKey: shouldActivate ? key : group.activeKey, previewKey };
      });
      if (shouldActivate && groupId !== currentUi.activeEditorGroupId) controllerContext.activateEditorGroup(groupId);
      // §8.18.5 tab limit enforcement: opening beyond the leaf's limit evicts
      // clean preview/least-recent candidates; dirty/pinned tabs are never
      // silently closed (over-limit surfaces a reason instead).
      if (!options.restoring) {
        const groupAfter = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), controllerContext.workspaceInstanceId).editorGroups[groupId];
        if (groupAfter) {
          const meta = new Map(groupAfter.openOrder.map((entryKey) => [
            entryKey,
            {
              key: entryKey,
              dirty: !!controllerContext.openFilesRef.current[entryKey]?.dirty,
              pinned: groupAfter.pinnedKeys.includes(entryKey),
              preview: groupAfter.previewKey === entryKey,
              lastUsedAt: 1_000_000 - controllerContext.mruFileKeysRef.current.indexOf(entryKey),
            },
          ]));
          const eviction = enforceTabPolicy(groupAfter.openOrder, meta, controllerContext.tabPolicyRef.current);
          if (eviction.kind === "evicted") {
            for (const evictedKey of eviction.evictedKeys) {
              if (evictedKey !== key) void controllerContext.closeFileRef.current?.(evictedKey, groupId, { discard: true });
            }
          } else if (eviction.kind === "over-limit-protected") {
            controllerContext.setStatusMessage(eviction.reason);
          }
        }
      }
      if (!isCurrent()) {
        return null;
      }
      // A close can have committed the layout before its LSP/buffer cleanup
      // finishes. Reopening the entry must wait for that cleanup so a late
      // buffer teardown cannot erase the newly visible editor.
      if (pendingClosedFile?.cleanup) {
        await pendingClosedFile.cleanup;
        if (!isCurrent()) return null;
        const latest = controllerContext.openFilesRef.current[key];
        if (pendingClosedFile.didCloseCompleted && latest && !latest.loading) {
          // Cleanup (including didClose) has finished. Resume the provider in
          // its existing ordered queue without making the visible reopen wait
          // for SDK discovery or initialize; edits keep feeding that queue.
          void controllerContext.syncLspDocument(latest, "open").catch((error) => {
            if (isCurrent() && controllerContext.openFilesRef.current[key]) {
              controllerContext.setStatusMessage(errorMessage(error));
            }
          });
        }
      }
      if (controllerContext.openFilesRef.current[key] && !controllerContext.openFilesRef.current[key].loading) {
        const existing = controllerContext.openFilesRef.current[key];
        return { canonicalFileKey: existing?.key ?? key, groupId, error: existing?.error ?? null };
      }
      // Library sources (JDK / dependency classes) have no file to read: ask the
      // language server again so history and Recent Files can reopen them.
      const library = controllerContext.libraryBuffersRef.current[key];
      if (library) {
        controllerContext.setOpenFiles((current) => ({
          ...current,
          [key]: current[key] ?? { ...makeLibraryFile(library, ""), loading: true },
        }));
        try {
          const contents = await lspReadUriContents(
            controllerContext.lspDescriptorForPath(library.originRootPath, library.originFilePath),
            library.uri,
          );
          if (!isCurrent()) return null;
          const info: LibraryBufferInfo = {
            ...library,
            title: contents.title || library.title,
            container: contents.container ?? library.container,
            languageId: contents.languageId || library.languageId,
            decompiled: contents.decompiled,
          };
          controllerContext.libraryBuffersRef.current[key] = info;
          controllerContext.setOpenFiles((current) => ({ ...current, [key]: makeLibraryFile(info, contents.text) }));
          if (!options.restoring) controllerContext.setStatusMessage(`Opened ${info.title}`);
          return { canonicalFileKey: key, groupId, error: null };
        } catch (err) {
          const message = errorMessage(err);
          controllerContext.setOpenFiles((current) => ({
            ...current,
            [key]: {
              ...(current[key] ?? makeLibraryFile(library, "")),
              loading: false,
              error: message,
            },
          }));
          controllerContext.setStatusMessage(message);
          return { canonicalFileKey: key, groupId, error: message };
        }
      }
      controllerContext.setOpenFiles((current) => ({
        ...current,
        [key]: current[key] ?? makeLoadingFile(ref, controllerContext.rootsRef.current, controllerContext.looseFilesRef.current),
      }));
      try {
        const file = ref.kind === "root"
          ? await workspaceReadFile(controllerContext.findRoot(ref.rootId)?.path ?? "", ref.path)
          : await workspaceReadLooseFile(ref.path);
        if (!isCurrent()) {
          return null;
        }
        const nextRef = ref.kind === "root" ? { ...ref, path: file.path } : { ...ref, path: file.path };
        const meta = fileMeta(nextRef, controllerContext.rootsRef.current, controllerContext.looseFilesRef.current);
        // CodeMirror normalizes to LF; keep buffer + dirty compare on LF and
        // remember original EOL so save restores CRLF/CR on Windows files.
        const normalized = normalizeEditorText(file.text);
        controllerContext.setOpenFiles((current) => {
          const next = { ...current };
          if (fileKey(nextRef) !== key) delete next[key];
          next[fileKey(nextRef)] = {
            ref: nextRef,
            key: fileKey(nextRef),
            path: meta.path,
            title: meta.title,
            subtitle: meta.subtitle,
            languagePath: meta.languagePath,
            text: normalized.text,
            savedText: normalized.text,
            eol: normalized.eol,
            encoding: file.encoding ?? "UTF-8",
            bom: file.bom ?? file.text.startsWith("\uFEFF"),
            hash: file.hash,
            mtime: file.mtime,
            size: file.size,
            loading: false,
            saving: false,
            dirty: false,
            documentRevision: 0,
            error: null,
          };
          return next;
        });
        controllerContext.restoreBookmarksForFileKey(fileKey(nextRef), meta.subtitle);
        controllerContext.updateEditorGroup(groupId, (group) => ({
          ...group,
          openOrder: group.openOrder.map((item) => (item === key ? fileKey(nextRef) : item)),
          activeKey: group.activeKey === key ? fileKey(nextRef) : group.activeKey,
          previewKey: group.previewKey === key ? fileKey(nextRef) : group.previewKey,
          pinnedKeys: group.pinnedKeys.map((item) => (item === key ? fileKey(nextRef) : item)),
        }));
        if (!options.restoring) controllerContext.setStatusMessage(`Opened ${meta.subtitle}`);
        return { canonicalFileKey: fileKey(nextRef), groupId, error: null };
      } catch (err) {
        if (!isCurrent()) {
          return null;
        }
        const message = errorMessage(err);
        controllerContext.setOpenFiles((current) => ({
          ...current,
          [key]: {
            ...(current[key] ?? makeLoadingFile(ref, controllerContext.rootsRef.current, controllerContext.looseFilesRef.current)),
            loading: false,
            saving: false,
            error: message,
          },
        }));
        controllerContext.setStatusMessage(message);
        return { canonicalFileKey: key, groupId, error: message };
      }
    };
}



export { createHandleExternalFileChange, type HandleExternalFileChangeContext } from "./externalFileChanges";

export interface CloseFileContext {
  activeEditorGroupId: string;
  workspaceInstanceId: string;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  mruFileKeysRef: import("react").RefObject<string[]>;
  closeLayoutTabInLeaf: (instanceId: string, leafId: string, fileKey: string, policy?: import("../workspaceTabPolicy").AnyWorkspaceTabPolicy, lastUsedByKey?: ReadonlyMap<string, number>) => void;
  tabPolicyRef: import("react").RefObject<WorkspaceTabPolicyV3>;
  resourceRecoveryCoordinatorRef: import("react").RefObject<WorkspaceResourceRecoveryCoordinator>;
  pendingClosedFilesRef: import("react").RefObject<Map<string, PendingClosedFile>>;
  setClosedTabsStack: import("react").Dispatch<import("react").SetStateAction<readonly ClosedTabEntry[]>>;
  closeLspDocumentAndWait: (file: OpenFileState) => Promise<void>;
  pendingExternalFileEventsRef: import("react").RefObject<Map<string, PendingExternalFileEvent>>;
  saveTransactionRegistryRef: import("react").RefObject<SaveTransactionRegistry>;
  setOpenFiles: (updater: Record<string, OpenFileState> | ((prev: Record<string, OpenFileState>) => Record<string, OpenFileState>)) => void;
  setMarkdownModes: (updater: Record<string, MarkdownViewMode> | ((prev: Record<string, MarkdownViewMode>) => Record<string, MarkdownViewMode>)) => void;
  setLspFiles: (updater: Record<string, LspFileState> | ((prev: Record<string, LspFileState>) => Record<string, LspFileState>)) => void;
  observeResourceCleanupOutcome: (outcome: ResourceCleanupOutcome, handlers: ResourceCleanupHandlers) => void;
  setStatusMessage: (message: string) => void;
}


export function createCloseFile(controllerContext: CloseFileContext) {
  return async (
      key: string,
      groupId: EditorGroupId = controllerContext.activeEditorGroupId,
      options: { discard?: boolean } = {},
    ) => {
      const currentUi = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), controllerContext.workspaceInstanceId);
      const group = currentUi.editorGroups[groupId];
      if (!group.openOrder.includes(key)) return;
      const file = controllerContext.openFilesRef.current[key];
      const usedByOtherGroup = Object.values(currentUi.editorGroups).some(
        (candidate) => candidate.id !== groupId && candidate.openOrder.includes(key),
      );
      if (file?.dirty && !usedByOtherGroup && !options.discard) {
        const confirmed = await confirmAppDialog({
          title: "Close file",
          message: `Discard unsaved changes in ${file.subtitle}?`,
          confirmLabel: "Close",
          danger: true,
        });
        if (!confirmed) return;
      }
      const lastUsedMap = new Map(controllerContext.mruFileKeysRef.current.map((k, idx) => [k, 1_000_000 - idx]));
      controllerContext.closeLayoutTabInLeaf(controllerContext.workspaceInstanceId, groupId, key, controllerContext.tabPolicyRef.current, lastUsedMap);
      if (usedByOtherGroup) return;

      const coordinator = controllerContext.resourceRecoveryCoordinatorRef.current;
      const closedTree = currentUi.layoutTreeV2;
      const closedLeaf = findLeafNode(closedTree, groupId);
      const pendingClosedFile: PendingClosedFile | null = file
        ? { cleanup: null, didCloseCompleted: false }
        : null;
      const closedTabEntry: ClosedTabEntry | null = file
        ? {
            fileIdentity: workspaceFileIdentity(file.ref),
            ref: file.ref,
            title: file.title,
            subtitle: file.subtitle,
            leafPath: [groupId],
            closedAt: Date.now(),
            location: {
              leafId: groupId,
              treeRoute: buildReopenTreeRoute(closedTree, groupId),
              siblingFileKeys: (closedLeaf?.openFileKeys ?? []).filter((entryKey) => entryKey !== key),
            },
          }
        : null;
      if (pendingClosedFile) {
        controllerContext.pendingClosedFilesRef.current.set(key, pendingClosedFile);
      }
      // The editor tab is already committed closed at this point. Publish its
      // reopen claim before awaiting provider cleanup so shell routing can
      // honor an immediate Ctrl+Shift+T.
      if (closedTabEntry) {
        controllerContext.setClosedTabsStack((stack) => pushClosedTab(stack, closedTabEntry));
      }
      const isResourceReopened = () => {
        const liveUi = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), controllerContext.workspaceInstanceId);
        return Object.values(liveUi.editorGroups).some((candidate) => candidate.openOrder.includes(key));
      };

      const cleanupHandlers: ResourceCleanupHandlers = {
        didClose: async () => {
          if (!file || isResourceReopened()) return;
          await controllerContext.closeLspDocumentAndWait(file);
          if (pendingClosedFile) pendingClosedFile.didCloseCompleted = true;
        },
        watcher: () => {
          if (isResourceReopened()) return;
          const pending = controllerContext.pendingExternalFileEventsRef.current.get(key);
          if (pending) {
            window.clearTimeout(pending.timer);
            controllerContext.pendingExternalFileEventsRef.current.delete(key);
          }
        },
        buffer: () => {
          if (isResourceReopened()) return;
          controllerContext.saveTransactionRegistryRef.current.discardFile(
            controllerContext.workspaceInstanceId,
            key,
            `Buffer ${file?.subtitle ?? key} was closed`,
          );
          controllerContext.setOpenFiles((current) => {
            if (!(key in current)) return current;
            const next = { ...current };
            delete next[key];
            return next;
          });
          controllerContext.setMarkdownModes((current) => {
            if (!(key in current)) return current;
            const next = { ...current };
            delete next[key];
            return next;
          });
          controllerContext.setLspFiles((current) => {
            if (!(key in current)) return current;
            const next = { ...current };
            delete next[key];
            return next;
          });
        },
        history: () => {
          // History was published with the committed layout above. Keeping
          // this stage side-effect free prevents a delayed cleanup from
          // re-adding an entry that the user already reopened.
        },
      };
      const cleanupPromise = coordinator.executeResourceCleanup(key, cleanupHandlers);
      if (pendingClosedFile) pendingClosedFile.cleanup = cleanupPromise;
      try {
        const outcome = await cleanupPromise;
        controllerContext.observeResourceCleanupOutcome(outcome, cleanupHandlers);

        if (outcome.status === "committed-with-recovery") {
          controllerContext.setStatusMessage(outcome.message);
        }
      } finally {
        if (controllerContext.pendingClosedFilesRef.current.get(key) === pendingClosedFile) {
          controllerContext.pendingClosedFilesRef.current.delete(key);
        }
      }
    };
}
