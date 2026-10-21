import { useCallback } from "react";
import { lspDefinition,lspImplementation,lspTypeDefinition,type LspDocumentDescriptor,type LspLocation,type LspPosition } from "../../../../lib/editor/lsp";
import { WorkspaceSemanticQueryHost } from "../workspaceSemanticQueryHost";
import { type LocationPeekState } from "../LocationPeek";
import type { CodeWorkspaceFileRef } from "../../../../types";
import { type LspFileState,type OpenFileState,errorMessage } from "../codeWorkspaceModel";
import { type LspLocationOpenOptions,semanticLocationsFromResult } from "../controller/model";
import { createGoToDeclaration } from "../controller/semanticQueries";


export interface UseSemanticNavigationContext {
  setStatusMessage: (message: string) => void;
  setLocationPeek: (peek: LocationPeekState|null) => void;
  openLspLocation: (location: LspLocation,options?: LspLocationOpenOptions) => Promise<boolean>;
  recordNavigationLocation: (ref: CodeWorkspaceFileRef,position: import("../useWorkspaceNavigation").WorkspaceNavPosition,options?: { replaceSameFile?: boolean; }) => void;
  openFilesRef: import("react").RefObject<Record<string,import("../editorGroupTypes").OpenFileViewModel>>;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor|null;
  lspFilesRef: import("react").RefObject<Record<string,LspFileState>>;
  ensureLspDocumentSynced: (fileKey: string,requireSynchronized?: boolean) => Promise<OpenFileState|null>;
  beginSemanticQuery: (kind: import("../workspaceSemanticQueryHost").SemanticQueryKind,file: OpenFileState,descriptor: LspDocumentDescriptor,position: LspPosition) => { identity: import("../workspaceSemanticQueryHost").SemanticQueryIdentity; cancelKey: string; requestSeq: number; guards: import("../workspaceSemanticQueryHost").SemanticQueryLiveGuards; isCurrent: (candidate?: import("../workspaceSemanticQueryHost").SemanticQueryIdentity) => boolean; lspOptions: (signal: AbortSignal) => { signal: AbortSignal; cancelKey: string; requestSeq: number; }; };
  semanticQueryHostRef: import("react").RefObject<WorkspaceSemanticQueryHost>;
  updateLspStatusForFile: (file: OpenFileState,status: import("../../../../lib/editor/lsp").LspDocumentStatus) => void;
  goToDefinitionRef: import("react").RefObject<(file: OpenFileState,position: LspPosition) => Promise<boolean>>;
  peekDefinitionRef: import("react").RefObject<(file: OpenFileState,position: LspPosition) => Promise<boolean>>;
  goToDeclarationRef: import("react").RefObject<(file: OpenFileState,position: LspPosition) => Promise<boolean>>;
  goToTypeDefinitionRef: import("react").RefObject<(file: OpenFileState,position: LspPosition) => Promise<boolean>>;
  goToImplementationRef: import("react").RefObject<(file: OpenFileState,position: LspPosition) => Promise<boolean>>;
}

export function useSemanticNavigation(context: UseSemanticNavigationContext) {
  const {
    setStatusMessage,
    setLocationPeek,
    openLspLocation,
    recordNavigationLocation,
    openFilesRef,
    lspDescriptorForFile,
    lspFilesRef,
    ensureLspDocumentSynced,
    beginSemanticQuery,
    semanticQueryHostRef,
    updateLspStatusForFile,
    goToDefinitionRef,
    peekDefinitionRef,
    goToDeclarationRef,
    goToTypeDefinitionRef,
    goToImplementationRef,
  }=context;

  const navigateLocations=useCallback(async (
    title: string,
    locations: LspLocation[],
    emptyMessage: string,
    isCurrent?: () => boolean,
    origin?: { file: OpenFileState; ref: CodeWorkspaceFileRef; position: LspPosition; },
  ) => {
    if(!locations.length) {
      setStatusMessage(emptyMessage);
      return false;
    }
    if(isCurrent&&!isCurrent()) return false;
    if(locations.length===1) {
      setLocationPeek(null);
      if(isCurrent&&!isCurrent()) return false;
      return openLspLocation(locations[0],{
        isCurrent,
        originFile: origin?.file,
        recordHistory: !origin,
        onRevealed: origin
          ? (destinationRef,destinationPosition) => {
            // Reveal is the irreversible boundary for this navigation. Keep
            // the origin as the current entry, then add exactly one target.
            recordNavigationLocation(origin.ref,origin.position);
            recordNavigationLocation(destinationRef,destinationPosition,{ replaceSameFile: false });
          }
          :undefined,
      });
    }
    if(isCurrent&&!isCurrent()) return false;
    setLocationPeek({ title,locations });
    return true;
  },[openLspLocation,recordNavigationLocation,setStatusMessage]);

  /**
   * Resolve the live buffer used by semantic location navigation. CodeMirror
   * edits are published to the language server on a short debounce, so an
   * explicit definition/declaration/type/implementation request can otherwise
   * race the pending didChange and ask jdtls to resolve a stale document.
   * Library buffers are virtual server documents and deliberately bypass this
   * barrier; their descriptor already points at the originating workspace
   * document.
   */
  const prepareSemanticNavigationRequest=useCallback(async (
    file: OpenFileState,
  ): Promise<{ file: OpenFileState; descriptor: LspDocumentDescriptor; }|null> => {
    const live=openFilesRef.current[file.key]??file;
    if(live.library) {
      const descriptor=lspDescriptorForFile(live);
      return descriptor? { file: live,descriptor }:null;
    }

    const lspState=lspFilesRef.current[live.key];
    if(lspState?.status?.active) {
      const synchronized=await ensureLspDocumentSynced(live.key,true);
      if(!synchronized) {
        setStatusMessage("Definition navigation requires the language server to finish synchronizing current editor buffers");
        return null;
      }
      const descriptor=lspDescriptorForFile(synchronized);
      return descriptor? { file: synchronized,descriptor }:null;
    }

    const descriptor=lspDescriptorForFile(live);
    return descriptor? { file: live,descriptor }:null;
  },[ensureLspDocumentSynced,lspDescriptorForFile,setStatusMessage]);

  const goToDefinition=useCallback(
    async (file: OpenFileState,position: LspPosition) => {
      const prepared=await prepareSemanticNavigationRequest(file);
      if(!prepared) return false;
      const { file: live,descriptor }=prepared;
      try {
        const query=beginSemanticQuery("definitions",live,descriptor,position);
        const queryRes=await semanticQueryHostRef.current.executeEnvelope<LspLocation>({
          kind: "definitions",
          identity: query.identity,
          fetcher: async ({ signal }) => {
            const result=await lspDefinition(descriptor,position,query.lspOptions(signal));
            updateLspStatusForFile(live,result.status);
            return semanticLocationsFromResult(result);
          },
          guards: query.guards,
        });
        if(queryRes.status==="stale"||queryRes.status==="cancelled") {
          return false;
        }
        if(!query.isCurrent(queryRes.identity)) return false;
        if(queryRes.status==="unavailable"||queryRes.status==="error") {
          setStatusMessage(queryRes.error??"No definition found");
          return false;
        }
        return navigateLocations(
          "Definitions",
          queryRes.items,
          "No definition found",
          query.isCurrent,
          { file: live,ref: live.ref,position },
        );
      } catch(err) {
        setStatusMessage(errorMessage(err));
        return false;
      }
    },
    [beginSemanticQuery,navigateLocations,prepareSemanticNavigationRequest,setStatusMessage,updateLspStatusForFile],
  );

  const peekDefinition=useCallback(
    async (file: OpenFileState,position: LspPosition) => {
      const prepared=await prepareSemanticNavigationRequest(file);
      if(!prepared) return false;
      const { file: live,descriptor }=prepared;
      try {
        const query=beginSemanticQuery("definitions",live,descriptor,position);
        const queryRes=await semanticQueryHostRef.current.executeEnvelope<LspLocation>({
          kind: "definitions",
          identity: query.identity,
          fetcher: async ({ signal }) => {
            const result=await lspDefinition(descriptor,position,query.lspOptions(signal));
            updateLspStatusForFile(live,result.status);
            return semanticLocationsFromResult(result);
          },
          guards: query.guards,
        });
        if(queryRes.status==="stale"||queryRes.status==="cancelled") {
          return false;
        }
        if(!query.isCurrent(queryRes.identity)) return false;
        if(queryRes.status==="unavailable"||queryRes.status==="error") {
          setStatusMessage(queryRes.error??"No definition found");
          return false;
        }
        if(!queryRes.items.length) {
          setStatusMessage("No definition found");
          return false;
        }
        if(!query.isCurrent()) return false;
        setLocationPeek({ title: "Quick Definition",locations: queryRes.items });
        return true;
      } catch(err) {
        setStatusMessage(errorMessage(err));
        return false;
      }
    },
    [beginSemanticQuery,prepareSemanticNavigationRequest,setLocationPeek,setStatusMessage,updateLspStatusForFile],
  );

  const goToDeclaration=useCallback(
    createGoToDeclaration({
      openFilesRef,
      lspFilesRef,
      lspDescriptorForFile,
      goToDefinition,
      prepareSemanticNavigationRequest,
      setStatusMessage,
      beginSemanticQuery,
      semanticQueryHostRef,
      updateLspStatusForFile,
      navigateLocations,
    }),
    [beginSemanticQuery,goToDefinition,lspDescriptorForFile,navigateLocations,prepareSemanticNavigationRequest,setStatusMessage,updateLspStatusForFile],
  );

  const goToTypeDefinition=useCallback(
    async (file: OpenFileState,position: LspPosition) => {
      const prepared=await prepareSemanticNavigationRequest(file);
      if(!prepared) return false;
      const { file: live,descriptor }=prepared;
      const caps=lspFilesRef.current[live.key]?.status?.capabilities;
      if(caps&&!caps.typeDefinition) {
        setStatusMessage("Type definition is not supported by this language server");
        return false;
      }
      try {
        const query=beginSemanticQuery("typeDefinitions",live,descriptor,position);
        const queryRes=await semanticQueryHostRef.current.executeEnvelope<LspLocation>({
          kind: "typeDefinitions",
          identity: query.identity,
          fetcher: async ({ signal }) => {
            const result=await lspTypeDefinition(descriptor,position,query.lspOptions(signal));
            updateLspStatusForFile(live,result.status);
            return semanticLocationsFromResult(result);
          },
          guards: query.guards,
        });
        if(queryRes.status==="stale"||queryRes.status==="cancelled") {
          return false;
        }
        if(!query.isCurrent(queryRes.identity)) return false;
        if(queryRes.status==="unavailable"||queryRes.status==="error") {
          setStatusMessage(queryRes.error??"No type definition found");
          return false;
        }
        return navigateLocations(
          "Type definitions",
          queryRes.items,
          "No type definition found",
          query.isCurrent,
          { file: live,ref: live.ref,position },
        );
      } catch(err) {
        setStatusMessage(errorMessage(err));
        return false;
      }
    },
    [beginSemanticQuery,navigateLocations,prepareSemanticNavigationRequest,setStatusMessage,updateLspStatusForFile],
  );

  const goToImplementation=useCallback(
    async (file: OpenFileState,position: LspPosition) => {
      const prepared=await prepareSemanticNavigationRequest(file);
      if(!prepared) return false;
      const { file: live,descriptor }=prepared;
      const caps=lspFilesRef.current[live.key]?.status?.capabilities;
      if(caps&&!caps.implementation) {
        setStatusMessage("Go to implementation is not supported by this language server");
        return false;
      }
      try {
        const query=beginSemanticQuery("implementations",live,descriptor,position);
        const queryRes=await semanticQueryHostRef.current.executeEnvelope<LspLocation>({
          kind: "implementations",
          identity: query.identity,
          fetcher: async ({ signal }) => {
            const result=await lspImplementation(descriptor,position,query.lspOptions(signal));
            updateLspStatusForFile(live,result.status);
            return semanticLocationsFromResult(result);
          },
          guards: query.guards,
        });
        if(queryRes.status==="stale"||queryRes.status==="cancelled") {
          return false;
        }
        if(!query.isCurrent(queryRes.identity)) return false;
        if(queryRes.status==="unavailable"||queryRes.status==="error") {
          setStatusMessage(queryRes.error??"No implementation found");
          return false;
        }
        return navigateLocations(
          "Implementations",
          queryRes.items,
          "No implementation found",
          query.isCurrent,
          { file: live,ref: live.ref,position },
        );
      } catch(err) {
        setStatusMessage(errorMessage(err));
        return false;
      }
    },
    [beginSemanticQuery,navigateLocations,prepareSemanticNavigationRequest,setStatusMessage,updateLspStatusForFile],
  );
  goToDefinitionRef.current=goToDefinition;
  peekDefinitionRef.current=peekDefinition;
  goToDeclarationRef.current=goToDeclaration;
  goToTypeDefinitionRef.current=goToTypeDefinition;
  goToImplementationRef.current=goToImplementation;
  return { goToDefinition };
}
