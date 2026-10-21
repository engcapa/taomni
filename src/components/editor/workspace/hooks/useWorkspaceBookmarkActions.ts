import { useCallback } from "react";
import { selectCodeWorkspaceUi,useCodeWorkspaceStore,type BottomDockTabId } from "../../../../stores/codeWorkspaceStore";
import { promptAppDialog } from "../../../../lib/appDialogs";
import { type EditorSelectionRange } from "../host/types";
import {
  findBookmarkByMnemonic,
  isValidMnemonic,
  normalizeMnemonic,
  renameWorkspaceBookmarkGroup,
  setMnemonicBookmark,
  toggleWorkspaceBookmark,
  writeWorkspaceBookmarks,
  type WorkspaceBookmark,
} from "../todoBookmarks";


export interface UseWorkspaceBookmarkActionsContext {
  setBottomDockTab: (tab: BottomDockTabId|((prev: BottomDockTabId) => BottomDockTabId)) => void;
  setBottomDockOpen: (open: boolean|((prev: boolean) => boolean)) => void;
  workspaceInstanceId: string;
  activeKey: string|null;
  openFilesRef: import("react").RefObject<Record<string,import("../editorGroupTypes").OpenFileViewModel>>;
  setStatusMessage: (message: string) => void;
  editorSelectionRef: import("react").RefObject<EditorSelectionRange>;
  bookmarks: WorkspaceBookmark[];
  replaceBookmarks: (next: WorkspaceBookmark[]) => void;
  bookmarksRef: import("react").RefObject<WorkspaceBookmark[]>;
  openTodoOrBookmark: (item: { fileKey: string; pathLabel?: string; line: number; character: number; state?: WorkspaceBookmark["state"]; }) => Promise<boolean>;
}

export function useWorkspaceBookmarkActions(context: UseWorkspaceBookmarkActionsContext) {
  const {
    setBottomDockTab,
    setBottomDockOpen,
    workspaceInstanceId,
    activeKey,
    openFilesRef,
    setStatusMessage,
    editorSelectionRef,
    bookmarks,
    replaceBookmarks,
    bookmarksRef,
    openTodoOrBookmark,
  }=context;

  const openTodosPane=useCallback(() => {
    setBottomDockTab("todos");
    setBottomDockOpen(true);
  },[setBottomDockOpen,setBottomDockTab]);

  const toggleTodosPane=useCallback(() => {
    const ui=selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(),workspaceInstanceId);
    if(ui.bottomDockOpen&&ui.bottomDockTab==="todos") {
      setBottomDockOpen(false);
      return;
    }
    openTodosPane();
  },[openTodosPane,setBottomDockOpen,workspaceInstanceId]);

  const toggleBookmarkAtCursor=useCallback(() => {
    const file=activeKey? openFilesRef.current[activeKey]:null;
    if(!file) {
      setStatusMessage("Open a file to toggle bookmarks");
      return;
    }
    const position=editorSelectionRef.current.end;
    const lineText=file.text.split("\n")[position.line]??"";
    const label=lineText.trim()||`${file.title}:${position.line+1}`;
    const next=toggleWorkspaceBookmark(workspaceInstanceId,{
      fileKey: file.key,
      pathLabel: file.subtitle||file.path,
      line: position.line,
      character: position.character,
      label,
    },bookmarks);
    replaceBookmarks(next);
    setStatusMessage(next.some((item) => item.fileKey===file.key&&item.line===position.line)
      ? `Bookmarked line ${position.line+1}`
      :`Removed bookmark on line ${position.line+1}`);
    openTodosPane();
  },[activeKey,bookmarks,openTodosPane,replaceBookmarks,setStatusMessage,workspaceInstanceId]);

  const removeBookmark=useCallback((id: string) => {
    const next=bookmarksRef.current.filter((item) => item.id!==id);
    writeWorkspaceBookmarks(workspaceInstanceId,next);
    replaceBookmarks(next);
  },[replaceBookmarks,workspaceInstanceId]);

  const renameBookmarkGroup=useCallback((oldGroupName: string,newGroupName: string) => {
    const current=bookmarksRef.current;
    const next=renameWorkspaceBookmarkGroup(
      workspaceInstanceId,
      oldGroupName,
      newGroupName,
      current,
    );
    if(next===current) return;
    replaceBookmarks(next);
    setStatusMessage(`Renamed bookmark group to ${newGroupName.trim()}`);
  },[replaceBookmarks,setStatusMessage,workspaceInstanceId]);

  const jumpToMnemonicBookmark=useCallback((mnemonic: string) => {
    const target=findBookmarkByMnemonic(bookmarks,mnemonic);
    if(!target) {
      setStatusMessage(`No bookmark with mnemonic '${mnemonic}' found`);
      return;
    }
    void openTodoOrBookmark(target).then((opened) => {
      if(opened) setStatusMessage(`Jumped to bookmark [${target.mnemonic}] on line ${target.line+1}`);
    });
  },[bookmarks,openTodoOrBookmark,setStatusMessage]);

  const setMnemonicBookmarkAtCursor=useCallback((mnemonic: string) => {
    const file=activeKey? openFilesRef.current[activeKey]:null;
    if(!file) {
      setStatusMessage("Open a file to toggle mnemonic bookmarks");
      return;
    }
    const position=editorSelectionRef.current.end;
    const lineText=file.text.split("\n")[position.line]??"";
    const label=lineText.trim()||`${file.title}:${position.line+1}`;
    const next=setMnemonicBookmark(
      workspaceInstanceId,
      {
        fileKey: file.key,
        pathLabel: file.subtitle||file.path,
        line: position.line,
        character: position.character,
        label,
        mnemonic,
      },
      bookmarks,
    );
    replaceBookmarks(next);
    const setOnLine=next.some(
      (item) => item.fileKey===file.key&&item.line===position.line&&item.mnemonic===mnemonic,
    );
    setStatusMessage(
      setOnLine
        ? `Set bookmark [${mnemonic}] on line ${position.line+1}`
        :`Removed bookmark on line ${position.line+1}`,
    );
    openTodosPane();
  },[activeKey,bookmarks,openTodosPane,replaceBookmarks,setStatusMessage,workspaceInstanceId]);

  const chooseMnemonicBookmarkAtCursor=useCallback(async () => {
    const selected=await promptAppDialog({
      title: "Set Bookmark Mnemonic",
      label: "Mnemonic (0-9 or A-Z)",
      placeholder: "A",
      confirmLabel: "Set Bookmark",
    });
    if(selected===null) return;
    const trimmed=selected.trim();
    if(!isValidMnemonic(trimmed)) {
      setStatusMessage("Bookmark mnemonic must be exactly one letter or digit");
      return;
    }
    setMnemonicBookmarkAtCursor(normalizeMnemonic(trimmed));
  },[setMnemonicBookmarkAtCursor,setStatusMessage]);
  return { toggleTodosPane,toggleBookmarkAtCursor,chooseMnemonicBookmarkAtCursor,openTodosPane,jumpToMnemonicBookmark,removeBookmark,renameBookmarkGroup };
}
