import { useCallback } from "react";
import { type LspLocation } from "../../../../lib/editor/lsp";
import { type CodeWorkspaceEditorGroupState,type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import { type EditorSelectionRange } from "../host/types";
import { type WorkspaceBookmark } from "../todoBookmarks";
import type { CodeWorkspaceFileRef,CodeWorkspaceLooseFileInfo } from "../../../../types";


export interface UseWorkspaceLocationOpeningContext {
  openFilesRef: import("react").RefObject<Record<string,import("../editorGroupTypes").OpenFileViewModel>>;
  updateEditorGroup: (groupId: EditorGroupId,updater: CodeWorkspaceEditorGroupState|((prev: CodeWorkspaceEditorGroupState) => CodeWorkspaceEditorGroupState)) => void;
  activeEditorGroupId: string;
  openFile: (ref: CodeWorkspaceFileRef,options?: { preview?: boolean; groupId?: EditorGroupId; activate?: boolean; restoring?: boolean; isCurrent?: () => boolean; }) => Promise<{ canonicalFileKey: string; groupId: string; error: string|null; }|null>;
  looseFilesRef: import("react").RefObject<CodeWorkspaceLooseFileInfo[]>;
  setStatusMessage: (message: string) => void;
  activeKey: string|null;
  recordNavigationLocation: (ref: CodeWorkspaceFileRef,position: import("../useWorkspaceNavigation").WorkspaceNavPosition,options?: { replaceSameFile?: boolean; }) => void;
  editorSelectionRef: import("react").RefObject<EditorSelectionRange>;
  suppressNextHistoryRecord: () => void;
  revealEditorLocation: (key: string,range: LspLocation["range"]) => void;
}

export function useWorkspaceLocationOpening(context: UseWorkspaceLocationOpeningContext) {
  const {
    openFilesRef,
    updateEditorGroup,
    activeEditorGroupId,
    openFile,
    looseFilesRef,
    setStatusMessage,
    activeKey,
    recordNavigationLocation,
    editorSelectionRef,
    suppressNextHistoryRecord,
    revealEditorLocation,
  }=context;

  const openFileByKey=useCallback(async (key: string): Promise<boolean> => {
    const existing=openFilesRef.current[key];
    if(existing) {
      if(existing.loading||existing.error) return false;
      updateEditorGroup(activeEditorGroupId,(group) => (
        group.openOrder.includes(key)
          ? { ...group,activeKey: key }
          :{ ...group,openOrder: [...group.openOrder,key],activeKey: key,previewKey: group.previewKey===key? null:group.previewKey }
      ));
      return true;
    }
    if(key.startsWith("root:")) {
      const rest=key.slice("root:".length);
      const sep=rest.indexOf(":");
      if(sep>0) {
        const rootId=rest.slice(0,sep);
        const path=rest.slice(sep+1);
        await openFile({ kind: "root",rootId,path });
        const opened=openFilesRef.current[key];
        return !!opened&&!opened.loading&&!opened.error;
      }
    }
    if(key.startsWith("loose:")) {
      const id=key.slice("loose:".length);
      const loose=looseFilesRef.current.find((item) => item.id===id);
      if(loose) {
        await openFile({ kind: "loose",id: loose.id,path: loose.path });
        const opened=openFilesRef.current[key];
        return !!opened&&!opened.loading&&!opened.error;
      }
    }
    return false;
  },[activeEditorGroupId,openFile,updateEditorGroup]);

  const openTodoOrBookmark=useCallback(async (
    item: {
      fileKey: string;
      pathLabel?: string;
      line: number;
      character: number;
      state?: WorkspaceBookmark["state"];
    },
  ): Promise<boolean> => {
    if(item.state==="missing") {
      setStatusMessage(`Bookmark target is missing: ${item.pathLabel??item.fileKey}`);
      return false;
    }
    const origin=activeKey? openFilesRef.current[activeKey]:null;
    if(origin) {
      recordNavigationLocation(origin.ref,editorSelectionRef.current.end);
    }
    if(item.fileKey!==activeKey) suppressNextHistoryRecord();
    if(!await openFileByKey(item.fileKey)) {
      setStatusMessage(`Cannot open bookmark target: ${item.pathLabel??item.fileKey}`);
      return false;
    }
    const target=openFilesRef.current[item.fileKey];
    if(!target||target.loading||target.error) {
      setStatusMessage(`Cannot open bookmark target: ${item.pathLabel??item.fileKey}`);
      return false;
    }
    const position={ line: item.line,character: item.character };
    revealEditorLocation(item.fileKey,{
      start: position,
      end: position,
    });
    recordNavigationLocation(target.ref,position,{ replaceSameFile: false });
    return true;
  },[activeKey,openFileByKey,recordNavigationLocation,revealEditorLocation,setStatusMessage,suppressNextHistoryRecord]);
  return { openTodoOrBookmark };
}
