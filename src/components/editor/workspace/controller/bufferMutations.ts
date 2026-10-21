import { workspaceReadFile, workspaceReadLooseFile, workspaceReadFileWithEncoding, workspaceReadLooseFileWithEncoding, workspaceWriteFileEncoded, workspaceWriteLooseFileEncoded, type WorkspaceFile, type WorkspaceWriteAck } from "../../../../lib/editor/workspace";
import { lspFormatting, lspRangeFormatting, type LspDocumentDescriptor, type LspPosition } from "../../../../lib/editor/lsp";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore, type CodeWorkspaceEditorGroupState, type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import type { OpenFileEol } from "../editorGroupTypes";
import { type ExplicitIndentationOverride } from "../codeStyleModel";
import type { ResolvedCodeStyle } from "../editorConfigResolver";
import { type PreparedSaveCommitter, type WorkspaceStyleController } from "../workspaceStyleController";
import { buildPreparedSave, nextSaveTransactionId, prepareSaveTextForWriter, resolveWritePolicy, type SaveCommitResult } from "../saveCommit";
import { applySaveRaceWriteFault } from "../saveRaceProbe";
import { hasBlockingDiskEffectResolution } from "../workspaceRecovery";
import { filterFormattingRanges } from "../workspaceCodeStyleScheme";
import { activeSchemeForLanguage, schemeStyleFields, type CodeStyleSchemeStoreState } from "../workspaceCodeStyleSchemes";
import { confirmAppDialog } from "../../../../lib/appDialogs";
import { type EditorSelectionRange } from "../CodeMirrorHost";
import { applyLspTextEditsToString } from "../lspTextEdits";
import { WorkspaceEditHistory } from "../workspaceEditHistory";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { type LspFileState, type OpenFileState, errorMessage, lspPresetIdForPath, normalizeEditorText } from "../codeWorkspaceModel";
import { EDITOR_TEXT_COMMIT_IDLE_DELAY_MS, type FormatFileOutcome } from "./model";
import { type BufferMutationPatch, type MutationReason } from "./mutationTypes";



export interface MutateOpenBufferContext {
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  pendingEditorTextByFileRef: import("react").RefObject<Map<string, import("../editorGroupTypes").OpenFileViewModel>>;
  pendingEditorCaretByFileRef: import("react").RefObject<Map<string, { position: LspPosition; offset?: number; }>>;
  setOpenFiles: (updater: Record<string, OpenFileState> | ((prev: Record<string, OpenFileState>) => Record<string, OpenFileState>)) => void;
}


export function createMutateOpenBuffer(controllerContext: MutateOpenBufferContext): (key: string, patch: BufferMutationPatch, reason: MutationReason) => OpenFileState | null {
  return (
    key: string,
    patch: BufferMutationPatch,
    reason: MutationReason,
  ): OpenFileState | null => {
    const current = controllerContext.openFilesRef.current[key];
    if (!current) return null;

    const nextText = reason === "save-metadata" ? current.text : (patch.text !== undefined ? patch.text : current.text);
    const nextSavedText = patch.savedText !== undefined ? patch.savedText : current.savedText;
    const isTextChanged = reason !== "save-metadata" && patch.text !== undefined && patch.text !== current.text;

    let nextRevision = current.documentRevision ?? 0;
    if (reason === "save-writeback") {
      nextRevision = patch.documentRevision !== undefined
        ? Math.max(current.documentRevision ?? 0, patch.documentRevision)
        : (current.documentRevision ?? 0);
    } else if (reason === "save-metadata") {
      nextRevision = current.documentRevision ?? 0;
    } else if (isTextChanged || reason === "reload" || reason === "workspace-edit" || reason === "history-replay") {
      nextRevision = (current.documentRevision ?? 0) + 1;
    }

    const calculatedDirty = patch.dirty !== undefined
      ? patch.dirty
      : (nextText !== nextSavedText);

    const next: OpenFileState = {
      ...current,
      ...patch,
      text: nextText,
      savedText: nextSavedText,
      dirty: calculatedDirty,
      documentRevision: nextRevision,
      // Preserve the replay identity across save metadata/writeback for the
      // same text. React may observe these together with the restored text;
      // clearing it early would create a second document undo entry.
      historyReplay: reason === "history-replay"
        || (current.historyReplay === true && !isTextChanged
          && (reason === "save-metadata" || reason === "save-writeback")),
    };

    controllerContext.openFilesRef.current = { ...controllerContext.openFilesRef.current, [key]: next };
    if (reason === "user-edit") {
      controllerContext.pendingEditorTextByFileRef.current.set(key, next);
    } else {
      controllerContext.pendingEditorTextByFileRef.current.delete(key);
      controllerContext.pendingEditorCaretByFileRef.current.delete(key);
      controllerContext.setOpenFiles((prev) => ({ ...prev, [key]: next }));
    }
    return next;
  };
}



export interface QueueEditorTextUpdateContext {
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  workspaceInstanceId: string;
  updateEditorGroup: (groupId: EditorGroupId, updater: CodeWorkspaceEditorGroupState | ((prev: CodeWorkspaceEditorGroupState) => CodeWorkspaceEditorGroupState)) => void;
  workspaceEditHistory: WorkspaceEditHistory;
  setWorkspaceEditHistoryRevision: import("react").Dispatch<import("react").SetStateAction<number>>;
  mutateOpenBuffer: (key: string, patch: BufferMutationPatch, reason: MutationReason) => OpenFileState | null;
  pendingEditorCaretByFileRef: import("react").RefObject<Map<string, { position: LspPosition; offset?: number; }>>;
  editorSelectionRef: import("react").RefObject<EditorSelectionRange>;
  semanticIndex: import("../useWorkspaceSemanticIndex").WorkspaceSemanticIndexController;
  scheduleLiveLspSync: (key: string) => void;
  pendingEditorTextTimerRef: import("react").RefObject<number | null>;
  flushPendingEditorText: () => void;
}


export function createQueueEditorTextUpdate(controllerContext: QueueEditorTextUpdateContext): (key: string, text: string, caret?: LspPosition, caretOffset?: number) => void {
  return (
    key: string,
    text: string,
    caret?: LspPosition,
    caretOffset?: number,
  ) => {
    const file = controllerContext.openFilesRef.current[key];
    if (!file || file.text === text) return;
    // ED-PARITY-003 S1: typing promotes any preview tab for this file to a
    // formal tab. EditorGroup's onChange wrapper captures previewKey in a
    // memo-skipped CodeMirrorHost closure, so a preview set without a doc
    // change would never promote there; promote here where the edit is
    // guaranteed to be observed (dirty proves this path runs).
    const liveUiForPreview = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), controllerContext.workspaceInstanceId);
    for (const [previewGroupId, previewGroup] of Object.entries(liveUiForPreview.editorGroups)) {
      if (previewGroup.previewKey === key) {
        controllerContext.updateEditorGroup(previewGroupId as EditorGroupId, (current) => (
          current.previewKey === key ? { ...current, previewKey: null } : current
        ));
      }
    }
    // Once the user starts a new character-level edit, CodeMirror becomes the
    // active undo owner. Retaining an older cross-file transaction here would
    // make Ctrl/Cmd+Z skip over the fresh typing and surprise the user.
    const historyState = controllerContext.workspaceEditHistory.state();
    if (historyState.canUndo || historyState.canRedo) {
      controllerContext.workspaceEditHistory.clear();
      controllerContext.setWorkspaceEditHistoryRevision((revision) => revision + 1);
    }
    const next = controllerContext.mutateOpenBuffer(key, { text, error: null }, "user-edit");
    if (!next) return;
    controllerContext.pendingEditorCaretByFileRef.current.set(key, {
      position: caret ?? controllerContext.editorSelectionRef.current.start,
      offset: caretOffset,
    });
    const activeFilePath = next.path ?? next.title;
    controllerContext.semanticIndex.invalidateSilently("document-edited", [activeFilePath]);
    // Drive didChange from the live buffer only when a language server can
    // actually use it — plain text / missing LSP must not pay IPC cost.
    controllerContext.scheduleLiveLspSync(key);
    if (controllerContext.pendingEditorTextTimerRef.current !== null) {
      window.clearTimeout(controllerContext.pendingEditorTextTimerRef.current);
    }
    controllerContext.pendingEditorTextTimerRef.current = window.setTimeout(
      controllerContext.flushPendingEditorText,
      EDITOR_TEXT_COMMIT_IDLE_DELAY_MS,
    );
  };
}



export interface WriteTextSnapshotContext {
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
}


export function createWriteTextSnapshot(controllerContext: WriteTextSnapshotContext): (request: { fileKey?: string; filePath: string; logicalText: string; expectedDiskHash: string | null; policy: { eol: OpenFileEol | "lf" | "crlf" | "cr"; encoding?: string; bom?: boolean; }; bufferVersion?: number; styleGeneration?: number; }) => Promise<WorkspaceWriteAck> {
  return async (request: {
    fileKey?: string;
    filePath: string;
    logicalText: string;
    expectedDiskHash: string | null;
    policy: {
      eol: OpenFileEol | "lf" | "crlf" | "cr";
      encoding?: string;
      bom?: boolean;
    };
    bufferVersion?: number;
    styleGeneration?: number;
  }): Promise<WorkspaceWriteAck> => {
    const targetEncoding = request.policy.encoding ?? "UTF-8";
    const targetBom = request.policy.bom ?? false;
    const rawEol = request.policy.eol ?? "LF";
    const eol = (typeof rawEol === "string" ? rawEol.toLowerCase() : "lf") as "lf" | "crlf" | "cr";

    const normalizedText = prepareSaveTextForWriter(request.logicalText, {
      eol,
      encoding: targetEncoding,
      bom: targetBom,
    });

    let rootPath: string | null = null;
    let relPath: string | null = null;

    if (request.fileKey) {
      const file = controllerContext.openFilesRef.current[request.fileKey];
      if (file && file.ref.kind === "root") {
        const root = controllerContext.rootsRef.current.find((r) => r.id === (file.ref as { rootId: string }).rootId);
        if (root) {
          rootPath = root.path;
          relPath = file.ref.path;
        }
      }
    }

    if (!rootPath || !relPath) {
      const matchingRoot = controllerContext.rootsRef.current.find(
        (r) => request.filePath.startsWith(r.path + "/") || request.filePath === r.path,
      );
      if (matchingRoot) {
        rootPath = matchingRoot.path;
        relPath = request.filePath.slice(matchingRoot.path.length).replace(/^\/+/, "");
      }
    }

    const pendingWrite = rootPath && relPath
      ? workspaceWriteFileEncoded(
        rootPath,
        relPath,
        normalizedText,
        request.expectedDiskHash,
        targetEncoding,
        targetBom,
      )
      : workspaceWriteLooseFileEncoded(
        request.filePath,
        normalizedText,
        request.expectedDiskHash,
        targetEncoding,
        targetBom,
      );
    // ED-PARITY-002 QA build only: the real write attempt above runs first;
    // the probe may withhold its response (and optionally delay it) so the
    // production unknown-effect read-back path classifies real disk bytes.
    // A no-op in normal builds and when the probe is not armed.
    let writtenAck: WorkspaceWriteAck | null = null;
    let writeFailure: unknown = null;
    try {
      writtenAck = await pendingWrite;
    } catch (error) {
      writeFailure = error;
    }
    return applySaveRaceWriteFault(request.filePath, writtenAck, writeFailure);
  };
}



export interface SaveOpenBufferTextContext {
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  workspaceInstanceId: string;
  workspaceStyleControllerRef: import("react").RefObject<WorkspaceStyleController>;
  commitOpenBufferPreparedSave: PreparedSaveCommitter;
}


export function createSaveOpenBufferText(controllerContext: SaveOpenBufferTextContext): (key: string, textToSave?: string, saveOptions?: { eol?: OpenFileEol | "lf" | "crlf" | "cr"; encoding?: string; bom?: boolean; }, onCommitResult?: (result: SaveCommitResult) => void) => Promise<WorkspaceFile | null> {
  return async (
    key: string,
    textToSave?: string,
    saveOptions?: {
      eol?: OpenFileEol | "lf" | "crlf" | "cr";
      encoding?: string;
      bom?: boolean;
    },
    /** ED-IMPROVE-002: observes the shared committer's typed result. */
    onCommitResult?: (result: SaveCommitResult) => void,
  ): Promise<WorkspaceFile | null> => {
    const file = controllerContext.openFilesRef.current[key];
    if (!file || file.loading) {
      throw new Error("Open buffer is not available to save");
    }
    if (file.library) {
      throw new Error(`${file.title} is a read-only library source`);
    }

    // §8.19.1: a `pending-readback`/`foreign-blocked` ledger row blocks
    // automatic retries against the same path until a re-read confirms the
    // real bytes or the user resolves the row.
    const pendingUnknownPath = controllerContext.absolutePathForOpenFile(file) ?? file.path ?? file.title;
    if (hasBlockingDiskEffectResolution(controllerContext.workspaceInstanceId, pendingUnknownPath)) {
      throw new Error(
        `A previous save of ${file.subtitle} has an unverified disk result. Confirm the file contents in the recovery center before saving again.`,
      );
    }

    // 1. Prepare phase: capture the immutable PreparedSave through the shared
    // builder so every path (open-dirty, open-clean, replay) shares one shape.
    const prepared = buildPreparedSave({
      transactionId: nextSaveTransactionId(),
      workspaceId: controllerContext.workspaceInstanceId,
      fileKey: key,
      filePath: controllerContext.absolutePathForOpenFile(file) ?? file.path ?? file.title,
      text: textToSave !== undefined ? textToSave : file.text,
      bufferRevision: file.documentRevision ?? 0,
      styleGeneration: controllerContext.workspaceStyleControllerRef.current.getGeneration(),
      expectedDiskHash: file.hash ?? null,
      policy: resolveWritePolicy({
        explicit: {
          eol: saveOptions?.eol,
          encoding: saveOptions?.encoding,
          bom: saveOptions?.bom,
        },
        file,
      }),
    });

    const result = await controllerContext.commitOpenBufferPreparedSave(prepared);
    onCommitResult?.(result);
    if (result.diskEffect === "committed") return result.file;
    return null;
  };
}



export interface FormatFileTextContext {
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  workspaceStyleControllerRef: import("react").RefObject<WorkspaceStyleController>;
  indentationOverridesRef: import("react").RefObject<Record<string, ExplicitIndentationOverride | null>>;
  codeStyleSchemesRef: import("react").RefObject<CodeStyleSchemeStoreState>;
  resolvedCodeStylesRef: import("react").RefObject<Record<string, ResolvedCodeStyle>>;
  updateLspStatusForFile: (file: OpenFileState, status: import("../../../../lib/editor/lsp").LspDocumentStatus) => void;
}


export function createFormatFileText(controllerContext: FormatFileTextContext): (file: OpenFileState, selection?: EditorSelectionRange | null) => Promise<FormatFileOutcome> {
  return async (
    file: OpenFileState,
    selection: EditorSelectionRange | null = null,
  ): Promise<FormatFileOutcome> => {
    // No language-server preset means no provider can ever answer for this
    // file: report the typed unavailable reason instead of calling one.
    if (!lspPresetIdForPath(file.languagePath)) {
      return {
        state: "unavailable",
        reason: `No formatter provider for ${file.languagePath} is available`,
      };
    }
    const descriptor = controllerContext.lspDescriptorForFile(file);
    if (!descriptor) {
      return {
        state: "unavailable",
        reason: `No formatter provider for ${file.languagePath} is available`,
      };
    }
    const capabilities = controllerContext.lspFilesRef.current[file.key]?.status?.capabilities ?? null;
    const languageLabel = controllerContext.lspFilesRef.current[file.key]?.status?.languageId
      ?? file.languagePath.split(".").pop()
      ?? file.languagePath;
    const hasSelection = !!selection && !selection.empty
      && (selection.start.line !== selection.end.line
        || selection.start.character !== selection.end.character);
    const useRange = hasSelection && (capabilities?.rangeFormatting ?? false);
    if (capabilities && hasSelection && !capabilities.rangeFormatting) {
      return {
        state: "unavailable",
        reason: capabilities.formatting
          ? "The provider does not support range formatting — clear the selection to reformat the whole file"
          : `No formatter provider for ${languageLabel} supports selection reformatting`,
      };
    }
    if (capabilities && !capabilities.formatting) {
      return {
        state: "unavailable",
        reason: `No formatter provider for ${languageLabel} is running`,
      };
    }

    const absPath = controllerContext.absolutePathForOpenFile(file) ?? file.languagePath;
    const schemeLanguageKey = file.languagePath.split(".").pop()?.toLowerCase() ?? "";
    const codeStyle = await controllerContext.workspaceStyleControllerRef.current.resolveForFile({
      filePath: absPath,
      explicitOverride: controllerContext.indentationOverridesRef.current[file.key],
      text: file.text,
      activeSchemeFields: schemeStyleFields(
        activeSchemeForLanguage(controllerContext.codeStyleSchemesRef.current, schemeLanguageKey || null),
      ),
    });
    controllerContext.resolvedCodeStylesRef.current[file.key] = codeStyle;

    const ranges = filterFormattingRanges(
      file.text,
      hasSelection && selection ? { startLine: selection.start.line, endLine: selection.end.line } : null,
      true,
    );
    if (ranges.length === 0) return { state: "unchanged", text: file.text };

    const result = useRange && selection
      ? await lspRangeFormatting(descriptor, {
        start: selection.start,
        end: selection.end,
      }, {
        tabSize: codeStyle.tabSize,
        insertSpaces: codeStyle.insertSpaces,
      })
      : await lspFormatting(descriptor, {
        tabSize: codeStyle.tabSize,
        insertSpaces: codeStyle.insertSpaces,
      });
    controllerContext.updateLspStatusForFile(file, result.status);
    if (!result.edits.length) return { state: "unchanged", text: file.text };
    const filteredEdits = result.edits.filter((edit) => (
      ranges.some((range) => edit.range.start.line >= range.startLine && edit.range.end.line <= range.endLine)
    ));
    if (!filteredEdits.length) return { state: "unchanged", text: file.text };
    const nextText = applyLspTextEditsToString(file.text, filteredEdits);
    return nextText === file.text
      ? { state: "unchanged", text: nextText }
      : { state: "formatted", text: nextText };
  };
}



export interface ReloadFileContext {
  activeKey: string | null;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  setStatusMessage: (message: string) => void;
  setOpenFiles: (updater: Record<string, OpenFileState> | ((prev: Record<string, OpenFileState>) => Record<string, OpenFileState>)) => void;
  findRoot: (rootId: string) => CodeWorkspaceRootInfo | null;
  mutateOpenBuffer: (key: string, patch: BufferMutationPatch, reason: MutationReason) => OpenFileState | null;
}


export function createReloadFile(controllerContext: ReloadFileContext): (key?: string | null) => Promise<void> {
  return async (key: string | null = controllerContext.activeKey) => {
      if (!key) return;
      const file = controllerContext.openFilesRef.current[key];
      if (!file) return;
      if (file.library) {
        controllerContext.setStatusMessage(`${file.title} is a read-only library source`);
        return;
      }
      if (file.dirty) {
        const confirmed = await confirmAppDialog({
          title: "Reload file",
          message: `Discard unsaved changes in ${file.subtitle}?`,
          confirmLabel: "Reload",
          danger: true,
        });
        if (!confirmed) return;
      }
      controllerContext.setOpenFiles((current) => ({
        ...current,
        [key]: {
          ...(current[key] ?? file),
          loading: true,
          error: null,
        },
      }));
      try {
        const reloaded = file.ref.kind === "root"
          ? await workspaceReadFile(controllerContext.findRoot(file.ref.rootId)?.path ?? "", file.ref.path)
          : await workspaceReadLooseFile(file.ref.path);
        const normalized = normalizeEditorText(reloaded.text);
        controllerContext.mutateOpenBuffer(
          key,
          {
            text: normalized.text,
            savedText: normalized.text,
            eol: normalized.eol,
            encoding: reloaded.encoding ?? file.encoding ?? "UTF-8",
            bom: reloaded.bom ?? reloaded.text.startsWith("\uFEFF"),
            hash: reloaded.hash,
            mtime: reloaded.mtime,
            size: reloaded.size,
            loading: false,
            saving: false,
            dirty: false,
            error: null,
          },
          "reload",
        );
        controllerContext.setStatusMessage(`Reloaded ${file.subtitle}`);
      } catch (err) {
        const message = errorMessage(err);
        controllerContext.setOpenFiles((current) => ({
          ...current,
          [key]: {
            ...(current[key] ?? file),
            loading: false,
            saving: false,
            error: message,
          },
        }));
        controllerContext.setStatusMessage(message);
      }
    };
}



export interface ReloadActiveFileWithEncodingContext {
  activeKey: string | null;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  setOpenFiles: (updater: Record<string, OpenFileState> | ((prev: Record<string, OpenFileState>) => Record<string, OpenFileState>)) => void;
  findRoot: (rootId: string) => CodeWorkspaceRootInfo | null;
  mutateOpenBuffer: (key: string, patch: BufferMutationPatch, reason: MutationReason) => OpenFileState | null;
  setFileEncodingDialogOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setStatusMessage: (message: string) => void;
}


export function createReloadActiveFileWithEncoding(controllerContext: ReloadActiveFileWithEncodingContext): (encoding: string) => Promise<void> {
  return async (encoding: string) => {
    const key = controllerContext.activeKey;
    const file = key ? controllerContext.openFilesRef.current[key] : null;
    if (!key || !file || file.library || file.loading || file.saving) return;
    if (file.dirty) {
      const confirmed = await confirmAppDialog({
        title: "Reload file with encoding",
        message: `Discard unsaved changes in ${file.subtitle} and decode it as ${encoding}?`,
        confirmLabel: "Reload",
        danger: true,
      });
      if (!confirmed) return;
    }
    if (typeof workspaceReadFileWithEncoding !== "function"
      || typeof workspaceReadLooseFileWithEncoding !== "function") {
      throw new Error("Explicit file encoding is available in the desktop workspace only");
    }
    controllerContext.setOpenFiles((current) => ({
      ...current,
      [key]: { ...(current[key] ?? file), loading: true, error: null },
    }));
    try {
      const reloaded = file.ref.kind === "root"
        ? await workspaceReadFileWithEncoding(controllerContext.findRoot(file.ref.rootId)?.path ?? "", file.ref.path, encoding)
        : await workspaceReadLooseFileWithEncoding(file.ref.path, encoding);
      const normalized = normalizeEditorText(reloaded.text);
      const next = controllerContext.mutateOpenBuffer(
        key,
        {
          text: normalized.text,
          savedText: normalized.text,
          eol: normalized.eol,
          encoding: reloaded.encoding ?? encoding,
          bom: reloaded.bom ?? false,
          hash: reloaded.hash,
          mtime: reloaded.mtime,
          size: reloaded.size,
          loading: false,
          saving: false,
          dirty: false,
          error: null,
        },
        "reload",
      );
      controllerContext.setFileEncodingDialogOpen(false);
      if (next) {
        controllerContext.setStatusMessage(`Reloaded ${file.subtitle} as ${next.encoding}${next.bom ? " BOM" : ""}`);
      }
    } catch (error) {
      const message = errorMessage(error);
      controllerContext.setOpenFiles((current) => ({
        ...current,
        [key]: { ...(current[key] ?? file), loading: false, saving: false, error: message },
      }));
      controllerContext.setStatusMessage(message);
      throw error instanceof Error ? error : new Error(message);
    }
  };
}
