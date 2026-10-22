import { useCallback } from "react";
import { type LspDocumentDescriptor,type LspLocation } from "../../../../lib/editor/lsp";
import { type RightPaneTabId } from "../../../../stores/codeWorkspaceStore";
import { type EditorSelectionRange } from "../host/types";
import { type WorkspaceIntelligencePreferences } from "../intelligencePreferences";
import { type QuickDocContent } from "../referenceDocumentation";
import { extractProviderDocLinks,openExternalDocumentation,validateExternalDocUrl } from "../referenceDocumentation";
import { LEGACY_CONTEXT_INFO_REASON,ReferenceInfoController,type ReferenceHistorySnapshot } from "../referenceInfoController";
import { type LspFileState,type OpenFileState } from "../codeWorkspaceModel";
import { createOpenQuickDocumentation } from "../controller/navigationActions";
import { type LspLocationOpenOptions } from "../controller/model";


export interface UseReferenceDocumentationContext {
  setPinnedDoc: (content: QuickDocContent|null) => void;
  setReferenceHistory: import("react").Dispatch<import("react").SetStateAction<ReferenceHistorySnapshot>>;
  referenceInfoController: ReferenceInfoController;
  setPinnedDocLocked: (locked: boolean) => void;
  setRightPaneTab: (tab: RightPaneTabId) => void;
  setRightPaneOpen: (open: boolean|((prev: boolean) => boolean)) => void;
  setQuickDocOpen: (open: boolean) => void;
  activeFile: import("../editorGroupTypes").OpenFileViewModel|null;
  editorSelectionRef: import("react").RefObject<EditorSelectionRange>;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor|null;
  setStatusMessage: (message: string) => void;
  showCodeInsightNotice: (message: string,action?: "configure"|null) => void;
  lspSessionGeneration: () => number;
  workspaceInstanceId: string;
  lspFilesRef: import("react").RefObject<Record<string,LspFileState>>;
  openFilesRef: import("react").RefObject<Record<string,import("../editorGroupTypes").OpenFileViewModel>>;
  updateLspStatusForFile: (file: OpenFileState,status: import("../../../../lib/editor/lsp").LspDocumentStatus) => void;
  setQuickDocContent: (content: QuickDocContent|null) => void;
  pinnedDoc: import("../referenceDocumentation").ReferenceContentEnvelope|null;
  pinnedDocLocked: boolean;
  intelligencePreferences: WorkspaceIntelligencePreferences;
  quickDocContent: import("../referenceDocumentation").ReferenceContentEnvelope|null;
  openLspLocation: (location: LspLocation,options?: LspLocationOpenOptions) => Promise<boolean>;
  quickDocOpen: boolean;
}

export function useReferenceDocumentation(context: UseReferenceDocumentationContext) {
  const {
    setPinnedDoc,
    setReferenceHistory,
    referenceInfoController,
    setPinnedDocLocked,
    setRightPaneTab,
    setRightPaneOpen,
    setQuickDocOpen,
    activeFile,
    editorSelectionRef,
    lspDescriptorForFile,
    setStatusMessage,
    showCodeInsightNotice,
    lspSessionGeneration,
    workspaceInstanceId,
    lspFilesRef,
    openFilesRef,
    updateLspStatusForFile,
    setQuickDocContent,
    pinnedDoc,
    pinnedDocLocked,
    intelligencePreferences,
    quickDocContent,
    openLspLocation,
    quickDocOpen,
  }=context;

  const pinQuickDocumentation=useCallback((content: QuickDocContent) => {
    setPinnedDoc(content);
    setReferenceHistory(referenceInfoController.pushHistory(content));
    setPinnedDocLocked(true);
    setRightPaneTab("documentation");
    setRightPaneOpen(true);
    setQuickDocOpen(false);
  },[
    referenceInfoController,
    setPinnedDoc,
    setPinnedDocLocked,
    setQuickDocOpen,
    setRightPaneOpen,
    setRightPaneTab,
  ]);

  const openQuickDocumentation=useCallback(createOpenQuickDocumentation({
    activeFile,
    editorSelectionRef,
    lspDescriptorForFile,
    setStatusMessage,
    showCodeInsightNotice,
    lspSessionGeneration,
    referenceInfoController,
    workspaceInstanceId,
    lspFilesRef,
    openFilesRef,
    updateLspStatusForFile,
    setQuickDocContent,
    setReferenceHistory,
    pinnedDoc,
    pinnedDocLocked,
    setPinnedDoc,
    intelligencePreferences,
    setPinnedDocLocked,
    setRightPaneTab,
    setRightPaneOpen,
    setQuickDocOpen,
  }),[
    activeFile,
    intelligencePreferences.quickDoc.defaultTarget,
    lspDescriptorForFile,
    lspSessionGeneration,
    pinnedDoc,
    pinnedDocLocked,
    referenceInfoController,
    setPinnedDoc,
    setPinnedDocLocked,
    setQuickDocContent,
    setQuickDocOpen,
    setRightPaneOpen,
    setRightPaneTab,
    setStatusMessage,
    updateLspStatusForFile,
    workspaceInstanceId,
  ]);

  /**
   * §8.20.2 W1 Type Info: ready ONLY when a provider hands back typed
   * content (`source:"provider"`). No standard LSP channel exists today and
   * hover markdown must never be converted into a type, so the honest
   * production result is an explicit per-kind unavailable state.
   */
  const runTypeInfo=useCallback(async () => {
    const file=activeFile;
    if(!file||file.loading) return;
    const descriptor=lspDescriptorForFile(file);
    const serverLabel=lspFilesRef.current[file.key]?.status?.displayName??"this language server";
    if(!descriptor) {
      setStatusMessage(`Type Info is not provided by ${serverLabel}`);
      return;
    }
    const position=editorSelectionRef.current.start;
    const outcome=await referenceInfoController.requestTyped({
      kind: "type-info",
      workspaceId: workspaceInstanceId,
      fileKey: file.key,
      uri: descriptor.documentUri??lspFilesRef.current[file.key]?.status?.uri??descriptor.filePath,
      languageId: descriptor.languageId??"plaintext",
      position,
      documentRevision: file.documentRevision,
      providerGeneration: lspSessionGeneration(),
    },async () => ({ state: "unavailable" as const,reason: "provider-no-type-info-channel" }));
    if(outcome.state==="ready"&&outcome.payload.kind==="type-info") {
      setStatusMessage(`Type: ${outcome.payload.display}`);
    } else if(outcome.state==="unavailable") {
      setStatusMessage(outcome.reason==="legacy-context-info-not-expression-static-data"
        ? "Legacy context info is not Expression Static Data"
        :`Type Info is not provided by ${serverLabel}`);
    } else if(outcome.state==="failed") {
      setStatusMessage(outcome.message);
    }
  },[
    activeFile,
    lspDescriptorForFile,
    lspSessionGeneration,
    referenceInfoController,
    setStatusMessage,
    workspaceInstanceId,
  ]);

  /**
   * §8.20.2 W1 Expression Static Data: discoverable action; when jdtls/the
   * current provider exposes no static-data channel the result is an explicit
   * provider-unavailable — never local text guessing. Legacy V2 context-info
   * records migrate through migrateLegacyContextInfoRecord inside the
   * controller and surface under the same unavailable umbrella.
   */
  const runExpressionStaticData=useCallback(async () => {
    const file=activeFile;
    if(!file||file.loading) return;
    const descriptor=lspDescriptorForFile(file);
    const serverLabel=lspFilesRef.current[file.key]?.status?.displayName??"this language server";
    if(!descriptor) {
      setStatusMessage(`Expression Static Data is not provided by ${serverLabel}`);
      return;
    }
    const position=editorSelectionRef.current.start;
    const outcome=await referenceInfoController.requestTyped({
      kind: "expression-static-data",
      workspaceId: workspaceInstanceId,
      fileKey: file.key,
      uri: descriptor.documentUri??lspFilesRef.current[file.key]?.status?.uri??descriptor.filePath,
      languageId: descriptor.languageId??"plaintext",
      position,
      documentRevision: file.documentRevision,
      providerGeneration: lspSessionGeneration(),
    },async () => ({ state: "unavailable" as const,reason: "provider-no-static-data-channel" }));
    if(outcome.state==="ready"&&outcome.payload.kind==="expression-static-data") {
      const summary=outcome.payload.facts.map((fact) => `${fact.label}: ${fact.value}`).join(" · ");
      setStatusMessage(summary);
    } else if(outcome.state==="unavailable") {
      setStatusMessage(outcome.reason===LEGACY_CONTEXT_INFO_REASON
        ? "Legacy context info records do not carry Expression Static Data"
        :`Expression Static Data is not provided by ${serverLabel}`);
    } else if(outcome.state==="failed") {
      setStatusMessage(outcome.message);
    }
  },[
    activeFile,
    lspDescriptorForFile,
    lspSessionGeneration,
    referenceInfoController,
    setStatusMessage,
    workspaceInstanceId,
  ]);

  /**
   * §8.20.2 W1 External Documentation: enabled only from a real provider URL
   * found in the last READY quick-documentation payload (extracted, never
   * synthesized from the symbol name); https-only policy stays at the service
   * boundary inside the controller.
   */
  const externalDocTargetFromProvider=useCallback((): { url: string; title: string; }|null => {
    const last=referenceInfoController.lastReady("quick-documentation");
    if(!last||last.payload.kind!=="quick-documentation") return null;
    const url=extractProviderDocLinks(last.payload.markdown)
      .find((candidate) => validateExternalDocUrl(candidate).kind==="allowed");
    if(!url) return null;
    return { url,title: quickDocContent?.title??last.identity.fileKey };
  },[quickDocContent?.title,referenceInfoController]);

  const runExternalDocumentation=useCallback(async () => {
    const target=externalDocTargetFromProvider();
    const outcome=await referenceInfoController.requestTyped({
      kind: "external-documentation",
      workspaceId: workspaceInstanceId,
      fileKey: activeFile?.key??"",
      uri: "",
      languageId: "",
      position: editorSelectionRef.current.start,
      documentRevision: activeFile?.documentRevision??0,
      providerGeneration: lspSessionGeneration(),
    },async () => {
      if(!target) return { state: "unavailable" as const,reason: "no-provider-url" };
      return {
        state: "payload" as const,
        payload: { kind: "external-documentation" as const,url: target.url,title: target.title },
      };
    });
    if(outcome.state==="ready"&&outcome.payload.kind==="external-documentation") {
      const decision=await openExternalDocumentation(outcome.payload.url);
      if(decision.kind!=="allowed") setStatusMessage("The documentation link could not be opened");
      return;
    }
    if(outcome.state==="failed") setStatusMessage(outcome.message);
  },[
    activeFile?.documentRevision,
    activeFile?.key,
    externalDocTargetFromProvider,
    lspSessionGeneration,
    referenceInfoController,
    setStatusMessage,
    workspaceInstanceId,
  ]);

  const openReferenceSource=useCallback((content: QuickDocContent) => {
    if(!content.sourceLocation) {
      setStatusMessage("Documentation source unavailable");
      return;
    }
    void openLspLocation(content.sourceLocation);
  },[openLspLocation,setStatusMessage]);

  const applyReferenceHistorySnapshot=useCallback((snapshot: ReferenceHistorySnapshot) => {
    setReferenceHistory(snapshot);
    if(!snapshot.content) return;
    if(quickDocOpen) setQuickDocContent(snapshot.content);
    if(pinnedDoc) setPinnedDoc(snapshot.content);
  },[pinnedDoc,quickDocOpen,setPinnedDoc]);

  const referenceHistoryBack=useCallback(() => {
    applyReferenceHistorySnapshot(referenceInfoController.goBack());
  },[applyReferenceHistorySnapshot,referenceInfoController]);

  const referenceHistoryForward=useCallback(() => {
    applyReferenceHistorySnapshot(referenceInfoController.goForward());
  },[applyReferenceHistorySnapshot,referenceInfoController]);
  return { openQuickDocumentation,runTypeInfo,externalDocTargetFromProvider,runExternalDocumentation,runExpressionStaticData,pinQuickDocumentation,openReferenceSource,referenceHistoryBack,referenceHistoryForward };
}
