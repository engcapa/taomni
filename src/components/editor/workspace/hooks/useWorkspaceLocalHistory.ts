import { useCallback,useState } from "react";
import { type LocalHistoryEntry } from "../../../../lib/localHistory";
import { type EditorSelectionRange } from "../host/types";
import {
  classifyCompareReadError,
  createFileCompareSession,
  createUnavailableCompareSession,
  type CompareSelection,
  type CompareTarget,
  type EditorCompareSession,
} from "../editorCompareModel";
import { type OpenFileState } from "../codeWorkspaceModel";
import { compareSelectionFromEditorSelection,compareTargetForOpenFile,compareDescriptorForOpenFile } from "../controller/model";


export interface UseWorkspaceLocalHistoryContext {
  openFilesRef: import("react").RefObject<Record<string,import("../editorGroupTypes").OpenFileViewModel>>;
  absolutePathForOpenFile: (file: OpenFileState) => string|null;
  setStatusMessage: (message: string) => void;
  editorSelectionRef: import("react").RefObject<EditorSelectionRange>;
  setActiveCompareSession: import("react").Dispatch<import("react").SetStateAction<EditorCompareSession|null>>;
  updateFileText: (key: string,text: string) => void;
}

export function useWorkspaceLocalHistory(context: UseWorkspaceLocalHistoryContext) {
  const { openFilesRef,absolutePathForOpenFile,setStatusMessage,editorSelectionRef,setActiveCompareSession,updateFileText }=context;

  /**
   * Persist an open buffer with an explicit text payload.
   * Used by WorkspaceEdit for open-clean files (§5.2.9): apply then save.
   * Unlike `saveFile`, this does not require the buffer to already be dirty.
   */
  const [localHistoryTarget,setLocalHistoryTarget]=useState<{ key: string; path: string; }|null>(null);

  const compareLocalHistorySnapshot=useCallback((
    key: string,
    entry: LocalHistoryEntry,
    snapshotText: string,
    options?: {
      file?: OpenFileState;
      selection?: CompareSelection;
      target?: CompareTarget;
    },
  ) => {
    const file=options?.file??openFilesRef.current[key];
    if(!file) return;
    const path=absolutePathForOpenFile(file);
    if(!path) {
      setStatusMessage(`${file.title} has no local filesystem path`);
      return;
    }
    const selection=options?.selection??compareSelectionFromEditorSelection(editorSelectionRef.current);
    const rightText=selection?.text??file.text;
    const rightTitle=selection? `${file.title} (Selection)`:file.title;
    const target=options?.target??compareTargetForOpenFile(file,selection);
    const result=createFileCompareSession(
      {
        title: `${file.title} @ ${entry.reason} #${entry.id}`,
        path: entry.path,
        text: snapshotText,
        encoding: file.encoding??"UTF-8",
        eol: file.eol,
        bom: file.bom??false,
        sizeBytes: entry.byteLen,
        source: "local-history",
        readOnly: true,
      },
      compareDescriptorForOpenFile(file,"buffer",path,rightText,rightTitle),
      target,
    );
    if(!result.session) {
      const unavailable=classifyCompareReadError(result.error??"Local history snapshot is unavailable");
      setActiveCompareSession(createUnavailableCompareSession({
        source: "local-history",
        title: `Compare ${file.title} with Local History`,
        unavailableTitle: "Local History snapshot",
        reason: unavailable.reason,
        message: unavailable.message,
        right: compareDescriptorForOpenFile(file,"buffer",path,rightText,rightTitle),
        target,
      }));
      return;
    }
    setActiveCompareSession(result.session);
  },[absolutePathForOpenFile,setStatusMessage]);

  const openLocalHistoryForKey=useCallback((key: string) => {
    const file=openFilesRef.current[key];
    if(!file) return;
    const absolute=absolutePathForOpenFile(file);
    if(!absolute) {
      setStatusMessage(file.library
        ? `${file.title} is a library source with no local history`
        :"Cannot resolve path for local history");
      return;
    }
    setLocalHistoryTarget({ key,path: absolute });
  },[absolutePathForOpenFile,setStatusMessage]);

  const restoreLocalHistoryText=useCallback((key: string,text: string) => {
    updateFileText(key,text);
    setStatusMessage("Restored local history snapshot into the editor buffer");
  },[setStatusMessage,updateFileText]);
  return { compareLocalHistorySnapshot,openLocalHistoryForKey,localHistoryTarget,setLocalHistoryTarget,restoreLocalHistoryText };
}
