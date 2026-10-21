import { useCallback,useEffect } from "react";
import { type WorkspaceEol } from "../../../../stores/codeWorkspaceStatusStore";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { type OpenFileState } from "../codeWorkspaceModel";
import { encodingSupportsBom } from "../controller/model";
import { createReloadActiveFileWithEncoding } from "../controller/bufferMutations";


export interface UseWorkspaceEncodingContext {
  activeKey: string|null;
  openFilesRef: import("react").RefObject<Record<string,import("../editorGroupTypes").OpenFileViewModel>>;
  setOpenFiles: (updater: Record<string,OpenFileState>|((prev: Record<string,OpenFileState>) => Record<string,OpenFileState>)) => void;
  findRoot: (rootId: string) => CodeWorkspaceRootInfo|null;
  mutateOpenBuffer: (key: string,patch: import("../controller/mutationTypes").BufferMutationPatch,reason: import("../controller/mutationTypes").MutationReason) => OpenFileState|null;
  setFileEncodingDialogOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setStatusMessage: (message: string) => void;
  pendingEncodingDialogFileKeyRef: import("react").RefObject<string|null>;
  activeFile: import("../editorGroupTypes").OpenFileViewModel|null;
}

export function useWorkspaceEncoding(context: UseWorkspaceEncodingContext) {
  const {
    activeKey,
    openFilesRef,
    setOpenFiles,
    findRoot,
    mutateOpenBuffer,
    setFileEncodingDialogOpen,
    setStatusMessage,
    pendingEncodingDialogFileKeyRef,
    activeFile,
  }=context;

  const reloadActiveFileWithEncoding=useCallback(createReloadActiveFileWithEncoding({
    activeKey,
    openFilesRef,
    setOpenFiles,
    findRoot,
    mutateOpenBuffer,
    setFileEncodingDialogOpen,
    setStatusMessage,
  }),[activeKey,findRoot,mutateOpenBuffer,setStatusMessage]);

  const convertActiveFileEncoding=useCallback((encoding: string,bom: boolean) => {
    const key=activeKey;
    const file=key? openFilesRef.current[key]:null;
    if(!key||!file||file.library||file.loading||file.saving) return;
    const effectiveBom=encodingSupportsBom(encoding)&&bom;
    setOpenFiles((current) => ({
      ...current,
      [key]: {
        ...(current[key]??file),
        encoding,
        bom: effectiveBom,
        dirty: true,
        error: null,
      },
    }));
    setStatusMessage(`${file.subtitle}: save as ${encoding}${effectiveBom? " BOM":""}`);
  },[activeKey,setStatusMessage]);

  const openFileEncodingDialog=useCallback(() => {
    const file=activeKey? openFilesRef.current[activeKey]:null;
    if(!file||file.library||file.loading) return;
    if(file.saving) {
      // Saving is an asynchronous transaction. Queue the user's intent so a
      // status-bar click that lands in the save/writeback window is honored
      // after the same active file reaches a settled state.
      pendingEncodingDialogFileKeyRef.current=activeKey;
      return;
    }
    setFileEncodingDialogOpen(true);
  },[activeKey]);

  useEffect(() => {
    const pendingKey=pendingEncodingDialogFileKeyRef.current;
    if(!pendingKey) return;
    if(pendingKey!==activeKey) {
      pendingEncodingDialogFileKeyRef.current=null;
      return;
    }
    const file=openFilesRef.current[pendingKey];
    if(!file||file.library||file.loading||file.saving) return;
    pendingEncodingDialogFileKeyRef.current=null;
    setFileEncodingDialogOpen(true);
  },[activeFile,activeKey]);

  const cycleActiveFileEol=useCallback(() => {
    const key=activeKey;
    const file=key? openFilesRef.current[key]:null;
    if(!key||!file||file.library||file.loading||file.saving) return;
    const nextEol: WorkspaceEol=file.eol==="LF"
      ? "CRLF"
      :file.eol==="CRLF"
        ? "CR"
        :"LF";
    setOpenFiles((current) => ({
      ...current,
      [key]: {
        ...(current[key]??file),
        eol: nextEol,
        dirty: true,
        error: null,
      },
    }));
    setStatusMessage(`${file.subtitle}: line endings set to ${nextEol}; save to apply`);
  },[activeKey,setOpenFiles,setStatusMessage]);

  const toggleActiveFileBom=useCallback(() => {
    const key=activeKey;
    const file=key? openFilesRef.current[key]:null;
    if(!key||!file||file.library||file.loading||file.saving) return;
    if(!encodingSupportsBom(file.encoding??"UTF-8")) {
      setStatusMessage(`${file.subtitle}: BOM is only available for UTF-8 and UTF-16 encodings`);
      return;
    }
    const nextBom=!(file.bom??false);
    setOpenFiles((current) => ({
      ...current,
      [key]: {
        ...(current[key]??file),
        bom: nextBom,
        dirty: true,
        error: null,
      },
    }));
    setStatusMessage(`${file.subtitle}: ${file.encoding??"UTF-8"} ${nextBom? "BOM enabled":"BOM disabled"}; save to apply`);
  },[activeKey,setOpenFiles,setStatusMessage]);
  return { cycleActiveFileEol,toggleActiveFileBom,openFileEncodingDialog,reloadActiveFileWithEncoding,convertActiveFileEncoding };
}
