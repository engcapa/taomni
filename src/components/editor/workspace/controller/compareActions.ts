import { workspaceReadFile, workspaceReadLooseFile } from "../../../../lib/editor/workspace";
import { selectFilePath } from "../../../../lib/ipc";
import { confirmAppDialog } from "../../../../lib/appDialogs";
import { readTextResult } from "../../../../lib/clipboard";
import { type EditorSelectionRange } from "../CodeMirrorHost";
import { WorkspaceEditHistory } from "../workspaceEditHistory";
import { classifyCompareReadError, createClipboardCompareSession, createFileCompareSession, createUnavailableCompareSession, MAX_COMPARE_SIZE_BYTES, normalizeCompareText, type EditorCompareSession } from "../editorCompareModel";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { type OpenFileState, normalizeFsPath, relativePathWithinRoot } from "../codeWorkspaceModel";
import { compareSelectionFromEditorSelection, compareTargetForOpenFile, compareDescriptorForOpenFile, compareTargetMatches, replaceCompareSelection } from "./model";
import { type BufferMutationPatch, type MutationReason } from "./mutationTypes";



export interface CompareWithClipboardContext {
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  editorSelectionRef: import("react").RefObject<EditorSelectionRange>;
  setActiveCompareSession: import("react").Dispatch<import("react").SetStateAction<EditorCompareSession | null>>;
}


export function createCompareWithClipboard(controllerContext: CompareWithClipboardContext): () => Promise<void> {
  return async () => {
    const file = controllerContext.activeFile;
    if (!file) return;
    const selection = compareSelectionFromEditorSelection(controllerContext.editorSelectionRef.current);
    const rightText = selection?.text ?? file.text;
    const rightTitle = selection ? `${file.title} (Selection)` : file.title;
    const target = compareTargetForOpenFile(file, selection);
    const rightDescriptor = {
      ...compareDescriptorForOpenFile(file, "buffer", file.path, rightText, rightTitle),
      readOnly: !!file.library,
    };
    try {
      const clipboard = await readTextResult();
      if (!clipboard.ok) {
        controllerContext.setActiveCompareSession(createUnavailableCompareSession({
          source: "clipboard",
          title: `Compare ${rightTitle} with Clipboard`,
          unavailableTitle: "Clipboard",
          reason: "read-failed",
          message: "The system clipboard could not be read.",
          right: rightDescriptor,
          target,
        }));
        return;
      }
      const result = createClipboardCompareSession(
        file.title,
        file.path,
        file.text,
        clipboard.text,
        selection,
        target,
      );
      if (!result.session) {
        const unavailable = classifyCompareReadError(result.error || "Clipboard is unavailable");
        controllerContext.setActiveCompareSession(createUnavailableCompareSession({
          source: "clipboard",
          title: `Compare ${rightTitle} with Clipboard`,
          unavailableTitle: "Clipboard",
          reason: unavailable.reason,
          message: unavailable.message,
          right: rightDescriptor,
          target,
        }));
        return;
      }
      controllerContext.setActiveCompareSession(result.session);
    } catch (error) {
      const unavailable = classifyCompareReadError(error);
      controllerContext.setActiveCompareSession(createUnavailableCompareSession({
        source: "clipboard",
        title: `Compare ${rightTitle} with Clipboard`,
        unavailableTitle: "Clipboard",
        reason: unavailable.reason,
        message: unavailable.message,
        right: rightDescriptor,
        target,
      }));
    }
  };
}



export interface CompareWithFileContext {
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  editorSelectionRef: import("react").RefObject<EditorSelectionRange>;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  setStatusMessage: (message: string) => void;
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  setActiveCompareSession: import("react").Dispatch<import("react").SetStateAction<EditorCompareSession | null>>;
}


export function createCompareWithFile(controllerContext: CompareWithFileContext): () => Promise<void> {
  return async () => {
    const file = controllerContext.activeFile;
    if (!file || file.library) return;
    const selection = compareSelectionFromEditorSelection(controllerContext.editorSelectionRef.current);
    const rightText = selection?.text ?? file.text;
    const rightTitle = selection ? `${file.title} (Selection)` : file.title;
    const target = compareTargetForOpenFile(file, selection);
    const activePath = controllerContext.absolutePathForOpenFile(file) ?? file.path;
    const rightDescriptor = compareDescriptorForOpenFile(file, "buffer", activePath, rightText, rightTitle);
    const selectedPath = await selectFilePath();
    if (!selectedPath) {
      controllerContext.setStatusMessage("Compare with file cancelled");
      return;
    }

    const normalizedPath = normalizeFsPath(selectedPath);
    const root = controllerContext.rootsRef.current.find((candidate) => (
      relativePathWithinRoot(candidate.path, normalizedPath) !== null
    ));
    const title = normalizedPath.split("/").filter(Boolean).at(-1) ?? normalizedPath;
    try {
      const selected = root
        ? await workspaceReadFile(
          root.path,
          relativePathWithinRoot(root.path, normalizedPath) ?? "",
          MAX_COMPARE_SIZE_BYTES + 1,
        )
        : await workspaceReadLooseFile(normalizedPath, MAX_COMPARE_SIZE_BYTES + 1);
      const result = createFileCompareSession(
        {
          title,
          path: normalizedPath,
          text: selected.text,
          encoding: selected.encoding ?? "UTF-8",
          bom: selected.bom ?? false,
          sizeBytes: selected.size,
          source: "file",
          readOnly: true,
        },
        rightDescriptor,
        target,
      );
      if (!result.session) {
        const unavailable = classifyCompareReadError(result.error || "Selected file is unavailable");
        controllerContext.setActiveCompareSession(createUnavailableCompareSession({
          source: "file",
          title: `Compare ${rightTitle} with ${title}`,
          unavailableTitle: title,
          reason: unavailable.reason,
          message: unavailable.message,
          right: rightDescriptor,
          target,
        }));
        return;
      }
      controllerContext.setActiveCompareSession(result.session);
    } catch (error) {
      const unavailable = classifyCompareReadError(error);
      controllerContext.setActiveCompareSession(createUnavailableCompareSession({
        source: "file",
        title: `Compare ${rightTitle} with ${title}`,
        unavailableTitle: title,
        reason: unavailable.reason,
        message: unavailable.message,
        right: rightDescriptor,
        target,
      }));
    }
  };
}



export interface ApplyCompareSessionContext {
  workspaceResourceOperationLocked: boolean;
  flushPendingEditorText: () => void;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  setStatusMessage: (message: string) => void;
  mutateOpenBuffer: (key: string, patch: BufferMutationPatch, reason: MutationReason) => OpenFileState | null;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  semanticIndex: import("../useWorkspaceSemanticIndex").WorkspaceSemanticIndexController;
  workspaceEditHistory: WorkspaceEditHistory;
  workspaceInstanceId: string;
  syncLspDocument: (file: OpenFileState, mode: "open" | "change") => Promise<void>;
  setWorkspaceEditHistoryRevision: import("react").Dispatch<import("react").SetStateAction<number>>;
  setActiveCompareSession: import("react").Dispatch<import("react").SetStateAction<EditorCompareSession | null>>;
}


export function createApplyCompareSession(controllerContext: ApplyCompareSessionContext): (session: EditorCompareSession, newText: string) => Promise<void> {
  return async (
    session: EditorCompareSession,
    newText: string,
  ) => {
    const target = session.target;
    if (!target) throw new Error("Comparison target is no longer available");
    if (controllerContext.workspaceResourceOperationLocked) {
      throw new Error("Workspace resource operations are busy");
    }
    controllerContext.flushPendingEditorText();
    let current = controllerContext.openFilesRef.current[target.fileKey] ?? null;
    if (current?.library) throw new Error(`${current.title} is a read-only library source`);
    if (!compareTargetMatches(current, target)) {
      throw new Error("Comparison target is stale; no changes were applied");
    }
    if (!current) throw new Error("Comparison target is no longer open");
    if (current.dirty) {
      const confirmed = await confirmAppDialog({
        title: "Apply comparison",
        message: `Replace unsaved changes in ${current.subtitle} with the comparison result?`,
        confirmLabel: "Apply",
      });
      if (!confirmed) {
        controllerContext.setStatusMessage("Comparison apply cancelled; unsaved changes were kept");
        return;
      }
      controllerContext.flushPendingEditorText();
      current = controllerContext.openFilesRef.current[target.fileKey] ?? null;
      if (current?.library) throw new Error(`${current.title} is a read-only library source`);
      if (!compareTargetMatches(current, target)) {
        throw new Error("Comparison target became stale; no changes were applied");
      }
      if (!current) throw new Error("Comparison target is no longer open");
    }

    const nextText = target.selection
      ? replaceCompareSelection(current.text, target.selection, newText)
      : normalizeCompareText(newText);
    if (nextText === null) {
      throw new Error("Comparison selection is stale; no changes were applied");
    }
    if (nextText === current.text) {
      controllerContext.setStatusMessage("Comparison already matches the current buffer");
      return;
    }

    const beforeText = current.text;
    const next = controllerContext.mutateOpenBuffer(target.fileKey, { text: nextText, error: null }, "workspace-edit");
    if (!next) throw new Error("Comparison target closed before apply");
    const affectedPath = controllerContext.absolutePathForOpenFile(next) ?? next.path;
    controllerContext.semanticIndex.invalidate("document-edited", [affectedPath]);
    controllerContext.workspaceEditHistory.push({
      id: `${controllerContext.workspaceInstanceId}:compare:${Date.now()}`,
      label: `Apply comparison from ${session.left.title}`,
      affectedPaths: [affectedPath],
      undo: async () => {
        const live = controllerContext.openFilesRef.current[target.fileKey] ?? null;
        if (!compareTargetMatches(live, {
          ...target,
          documentRevision: next.documentRevision ?? 0,
          expectedText: next.text,
        })) {
          throw new Error("Cannot undo comparison: the buffer changed after apply");
        }
        const restored = controllerContext.mutateOpenBuffer(target.fileKey, { text: beforeText, error: null }, "history-replay");
        if (!restored) throw new Error("Cannot undo comparison: target is closed");
        controllerContext.semanticIndex.invalidate("document-edited", [affectedPath]);
        await controllerContext.syncLspDocument(restored, "change");
      },
      redo: async () => {
        const live = controllerContext.openFilesRef.current[target.fileKey] ?? null;
        if (!live || live.text !== beforeText) {
          throw new Error("Cannot redo comparison: the buffer changed after undo");
        }
        const redone = controllerContext.mutateOpenBuffer(target.fileKey, { text: nextText, error: null }, "history-replay");
        if (!redone) throw new Error("Cannot redo comparison: target is closed");
        controllerContext.semanticIndex.invalidate("document-edited", [affectedPath]);
        await controllerContext.syncLspDocument(redone, "change");
      },
    });
    controllerContext.setWorkspaceEditHistoryRevision((revision) => revision + 1);
    await controllerContext.syncLspDocument(next, "change");
    controllerContext.setActiveCompareSession(null);
    controllerContext.setStatusMessage(`Applied comparison to ${next.subtitle}; undo is available`);
  };
}
