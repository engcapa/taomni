import { useCallback } from "react";
import { historyList,historyRead } from "../../../../lib/localHistory";
import { type EditorSelectionRange } from "../host/types";
import { WorkspaceEditHistory } from "../workspaceEditHistory";
import { classifyCompareReadError,createFileCompareSession,createUnavailableCompareSession,type EditorCompareSession } from "../editorCompareModel";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { type OpenFileState } from "../codeWorkspaceModel";
import { compareSelectionFromEditorSelection,compareTargetForOpenFile,compareDescriptorForOpenFile } from "../controller/model";
import { createCompareWithClipboard,createCompareWithFile,createApplyCompareSession } from "../controller/compareActions";


export interface UseWorkspaceComparisonsContext {
  openFilesRef: import("react").RefObject<Record<string,import("../editorGroupTypes").OpenFileViewModel>>;
  gitHeadTextByFile: Record<string,{ sourceKey: string; text: string|null; }>;
  setStatusMessage: (message: string) => void;
  setActiveCompareSession: import("react").Dispatch<import("react").SetStateAction<EditorCompareSession|null>>;
  activeFile: import("../editorGroupTypes").OpenFileViewModel|null;
  editorSelectionRef: import("react").RefObject<EditorSelectionRange>;
  absolutePathForOpenFile: (file: OpenFileState) => string|null;
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  compareLocalHistorySnapshot: (key: string,entry: import("../../../../lib/localHistory").LocalHistoryEntry,snapshotText: string,options?: { file?: OpenFileState; selection?: import("../editorCompareModel").CompareSelection; target?: import("../editorCompareModel").CompareTarget; }) => void;
  workspaceResourceOperationLocked: boolean;
  flushPendingEditorText: () => void;
  mutateOpenBuffer: (key: string,patch: import("../controller/mutationTypes").BufferMutationPatch,reason: import("../controller/mutationTypes").MutationReason) => OpenFileState|null;
  semanticIndex: import("../useWorkspaceSemanticIndex").WorkspaceSemanticIndexController;
  workspaceEditHistory: WorkspaceEditHistory;
  workspaceInstanceId: string;
  syncLspDocument: (file: OpenFileState,mode: "open"|"change") => Promise<void>;
  setWorkspaceEditHistoryRevision: import("react").Dispatch<import("react").SetStateAction<number>>;
}

export function useWorkspaceComparisons(context: UseWorkspaceComparisonsContext) {
  const {
    openFilesRef,
    gitHeadTextByFile,
    setStatusMessage,
    setActiveCompareSession,
    activeFile,
    editorSelectionRef,
    absolutePathForOpenFile,
    rootsRef,
    compareLocalHistorySnapshot,
    workspaceResourceOperationLocked,
    flushPendingEditorText,
    mutateOpenBuffer,
    semanticIndex,
    workspaceEditHistory,
    workspaceInstanceId,
    syncLspDocument,
    setWorkspaceEditHistoryRevision,
  }=context;

  /** ED-PARITY-022 DEC-022-02: VCS popup Show Diff — HEAD (read-only) ↔ buffer. */
  const showGitHeadDiff=useCallback((key: string) => {
    const file=openFilesRef.current[key];
    const head=gitHeadTextByFile[key];
    if(!file||!head||typeof head.text!=="string") {
      setStatusMessage("Show Diff is unavailable: the HEAD revision of this file is not loaded");
      return;
    }
    const target=compareTargetForOpenFile(file,undefined);
    const result=createFileCompareSession(
      { title: `${file.title} (HEAD)`,text: head.text??"",source: "file",readOnly: true },
      compareDescriptorForOpenFile(file,"buffer",file.path,file.text,file.title),
      target,
    );
    if(!result.session) {
      setStatusMessage(result.error??"Show Diff is unavailable for this file");
      return;
    }
    setActiveCompareSession(result.session);
  },[gitHeadTextByFile,setStatusMessage]);

  const compareWithClipboard=useCallback(createCompareWithClipboard({
    activeFile,
    editorSelectionRef,
    setActiveCompareSession,
  }),[activeFile]);

  const compareWithFile=useCallback(createCompareWithFile({
    activeFile,
    editorSelectionRef,
    absolutePathForOpenFile,
    setStatusMessage,
    rootsRef,
    setActiveCompareSession,
  }),[absolutePathForOpenFile,activeFile,setStatusMessage]);

  const compareWithLocalHistory=useCallback(async () => {
    const file=activeFile;
    if(!file) return;
    const path=absolutePathForOpenFile(file);
    if(!path) {
      setStatusMessage(file.library
        ? `${file.title} is a library source with no local history`
        :"Cannot resolve path for local history");
      return;
    }
    const selection=compareSelectionFromEditorSelection(editorSelectionRef.current);
    const target=compareTargetForOpenFile(file,selection);
    const rightText=selection?.text??file.text;
    const rightTitle=selection? `${file.title} (Selection)`:file.title;
    const rightDescriptor=compareDescriptorForOpenFile(file,"buffer",path,rightText,rightTitle);
    try {
      const entries=await historyList(path);
      const entry=entries[0];
      if(!entry) {
        setActiveCompareSession(createUnavailableCompareSession({
          source: "local-history",
          title: `Compare ${rightTitle} with Local History`,
          unavailableTitle: "Local History",
          reason: "no-history",
          message: `No local history snapshots exist for ${path}.`,
          right: rightDescriptor,
          target,
        }));
        return;
      }
      const snapshotText=await historyRead(entry.id);
      compareLocalHistorySnapshot(file.key,entry,snapshotText,{ file,selection,target });
    } catch(error) {
      const unavailable=classifyCompareReadError(error);
      setActiveCompareSession(createUnavailableCompareSession({
        source: "local-history",
        title: `Compare ${rightTitle} with Local History`,
        unavailableTitle: "Local History",
        reason: unavailable.reason,
        message: unavailable.message,
        right: rightDescriptor,
        target,
      }));
    }
  },[absolutePathForOpenFile,activeFile,compareLocalHistorySnapshot,setStatusMessage]);

  const applyCompareSession=useCallback(createApplyCompareSession({
    workspaceResourceOperationLocked,
    flushPendingEditorText,
    openFilesRef,
    setStatusMessage,
    mutateOpenBuffer,
    absolutePathForOpenFile,
    semanticIndex,
    workspaceEditHistory,
    workspaceInstanceId,
    syncLspDocument,
    setWorkspaceEditHistoryRevision,
    setActiveCompareSession,
  }),[
    absolutePathForOpenFile,
    flushPendingEditorText,
    mutateOpenBuffer,
    semanticIndex.invalidate,
    setStatusMessage,
    syncLspDocument,
    workspaceEditHistory,
    workspaceInstanceId,
    workspaceResourceOperationLocked,
  ]);
  return { compareWithClipboard,compareWithFile,compareWithLocalHistory,showGitHeadDiff,applyCompareSession };
}
