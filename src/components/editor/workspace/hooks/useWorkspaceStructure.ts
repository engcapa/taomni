import { useCallback } from "react";
import { lspDocumentSymbols,type LspDocumentDescriptor,type LspDocumentSymbol,type LspLocation } from "../../../../lib/editor/lsp";
import { javaSyntaxOutline } from "../javaSyntaxOutline";
import { type OpenFileState,errorMessage } from "../codeWorkspaceModel";


export interface UseWorkspaceStructureContext {
  activeKey: string|null;
  openFilesRef: import("react").RefObject<Record<string,import("../editorGroupTypes").OpenFileViewModel>>;
  structureFileRef: import("react").RefObject<string|null>;
  setStructureSymbols: (symbols: LspDocumentSymbol[]) => void;
  setStructureUnavailable: (reason: string|null) => void;
  setStructureSyntaxOnly: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setStructureLoading: (loading: boolean) => void;
  setStructureOpen: (open: boolean) => void;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor|null;
  updateLspStatusForFile: (file: OpenFileState,status: import("../../../../lib/editor/lsp").LspDocumentStatus) => void;
  revealEditorLocation: (key: string,range: LspLocation["range"]) => void;
}

export function useWorkspaceStructure(context: UseWorkspaceStructureContext) {
  const {
    activeKey,
    openFilesRef,
    structureFileRef,
    setStructureSymbols,
    setStructureUnavailable,
    setStructureSyntaxOnly,
    setStructureLoading,
    setStructureOpen,
    lspDescriptorForFile,
    updateLspStatusForFile,
    revealEditorLocation,
  }=context;

  const openStructurePopup=useCallback(async () => {
    const file=activeKey? openFilesRef.current[activeKey]:null;
    if(!file||file.loading) return;
    structureFileRef.current=file.key;
    setStructureSymbols([]);
    setStructureUnavailable(null);
    setStructureSyntaxOnly(false);
    setStructureLoading(true);
    setStructureOpen(true);
    // ED-PARITY-014 DEC-014-04: with no provider, Java files still get a
    // syntax-only outline from the bundled grammar, labelled as such.
    const syntaxFallback=(reason: string) => {
      const outline=/\.java$/i.test(file.title)? javaSyntaxOutline(file.text):[];
      if(outline.length>0) {
        setStructureSymbols(outline);
        setStructureSyntaxOnly(true);
        setStructureUnavailable(null);
      } else {
        setStructureUnavailable(reason);
      }
    };
    const descriptor=lspDescriptorForFile(file);
    if(!descriptor) {
      setStructureLoading(false);
      syntaxFallback("No language service for this file");
      return;
    }
    try {
      const result=await lspDocumentSymbols(descriptor);
      updateLspStatusForFile(file,result.status);
      if(structureFileRef.current!==file.key) return;
      if(result.symbols.length===0&&!result.status.active) {
        syntaxFallback(result.status.error??"Language server is not running for this file");
      } else {
        setStructureSymbols(result.symbols);
        setStructureUnavailable(null);
      }
    } catch(err) {
      if(structureFileRef.current===file.key) syntaxFallback(errorMessage(err));
    } finally {
      if(structureFileRef.current===file.key) setStructureLoading(false);
    }
  },[activeKey,lspDescriptorForFile,updateLspStatusForFile]);

  const pickStructureSymbol=useCallback(
    (symbol: LspDocumentSymbol) => {
      setStructureOpen(false);
      const key=structureFileRef.current;
      if(key) revealEditorLocation(key,symbol.selectionRange);
    },
    [revealEditorLocation],
  );

  const pickOutlineSymbol=useCallback((symbol: LspDocumentSymbol) => {
    if(activeKey) revealEditorLocation(activeKey,symbol.selectionRange);
  },[activeKey,revealEditorLocation]);
  return { openStructurePopup,pickOutlineSymbol,pickStructureSymbol };
}
