import { useCallback } from "react";
import { lspCompletion,lspCompletionResolve,type LspCompletionResolveResult,type LspCompletionResult,type LspDocumentDescriptor,type LspPosition } from "../../../../lib/editor/lsp";
import type { CompletionAcceptanceDiagnostic,CompletionInvocationRequest,CompletionRequestIdentity,CompletionRequestToken } from "../lspCompletion";
import { resolveCompletionScopeFacts,sameCompletionScopeFacts,type CompletionScopeFactsState } from "../completionScopeAdapter";
import { type LspFileState,type OpenFileState,isLspFeatureReady,shouldLiveSyncLsp } from "../codeWorkspaceModel";


export interface UseWorkspaceCompletionContext {
  openFilesRef: import("react").RefObject<Record<string,import("../editorGroupTypes").OpenFileViewModel>>;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor|null;
  absolutePathForOpenFile: (file: OpenFileState) => string|null;
  projectFactsRoot: string;
  workspaceInstanceId: string;
  lspSessionGeneration: () => number;
  setStatusMessage: (message: string) => void;
  projectDescriptorDiscovery: import("../../../../hooks/useProjectDescriptorDiscovery").ProjectDescriptorDiscoveryState;
  projectFacts: { refresh: (customOptions?: Partial<import("../../../../stores/projectFactsStore").FetchProjectFactsOptions>) => Promise<import("../../../../stores/projectFactsStore").WorkspaceProjectFactsEntry>; invalidate: (reason?: string) => void; workspaceRoot: string; generation: number; status: import("../../../../stores/projectFactsStore").ProjectFactsStatus; reason: string|null; fingerprint: string|null; structure: import("../projectStructureModel").ProjectStructureSnapshotV2|null; provenance: import("../../../../lib/editor/workspaceTooling").MavenToolingProvenance|import("../../../../lib/editor/workspaceTooling").GradleToolingProvenance|null; isStale: boolean; abortController?: AbortController|null; };
  lspFilesRef: import("react").RefObject<Record<string,LspFileState>>;
  ensureLspDocumentSynced: (fileKey: string,requireSynchronized?: boolean) => Promise<OpenFileState|null>;
  updateLspStatusForFile: (file: OpenFileState,status: import("../../../../lib/editor/lsp").LspDocumentStatus) => void;
}

export function useWorkspaceCompletion(context: UseWorkspaceCompletionContext) {
  const {
    openFilesRef,
    lspDescriptorForFile,
    absolutePathForOpenFile,
    projectFactsRoot,
    workspaceInstanceId,
    lspSessionGeneration,
    setStatusMessage,
    projectDescriptorDiscovery,
    projectFacts,
    lspFilesRef,
    ensureLspDocumentSynced,
    updateLspStatusForFile,
  }=context;

  // §8.16.2 completion identity: one live provider of workspace/file/session
  // identity for every completion request minted from this workspace tab.
  const completionIdentityForFile=useCallback(
    (file: OpenFileState): CompletionRequestIdentity|null => {
      const live=openFilesRef.current[file.key];
      if(!live) return null;
      const descriptor=lspDescriptorForFile(live);
      if(!descriptor) return null;
      const absPath=absolutePathForOpenFile(live)??live.path??file.path;
      // ED-COMP-004: every request records its effective project scope from
      // the ready same-workspace snapshot; unready/stale/degraded/cross-root
      // facts resolve to an explicit scope-facts-missing state (document
      // fallback) instead of guessed module/project scope.
      const projectScope=resolveCompletionScopeFacts(projectFactsRoot,absPath,"module");
      return {
        workspaceId: workspaceInstanceId,
        fileKey: live.key,
        filePath: absPath,
        uri: descriptor.documentUri??descriptor.filePath,
        languageId: descriptor.languageId??live.languagePath,
        documentRevision: live.documentRevision??0,
        lspSessionGeneration: lspSessionGeneration(),
        projectScope,
      };
    },
    [absolutePathForOpenFile,lspDescriptorForFile,lspSessionGeneration,projectFactsRoot,workspaceInstanceId],
  );

  const isCompletionTokenCurrent=useCallback(
    (token: CompletionRequestToken): boolean => {
      if(token.workspaceId!==workspaceInstanceId) return false;
      const live=openFilesRef.current[token.fileKey];
      if(!live) return false;
      const identity=completionIdentityForFile(live);
      return !!identity
        &&identity.workspaceId===token.workspaceId
        &&identity.fileKey===token.fileKey
        &&identity.filePath===token.filePath
        &&identity.uri===token.uri
        &&identity.languageId===token.languageId
        &&identity.documentRevision===token.documentRevision
        &&identity.lspSessionGeneration===token.lspSessionGeneration
        &&sameCompletionScopeFacts(identity.projectScope,token.projectScope);
    },
    [completionIdentityForFile,workspaceInstanceId],
  );

  const reportCompletionDiagnostic=useCallback((
    kind: CompletionAcceptanceDiagnostic,
    detail?: string,
  ) => {
    if(kind==="truncated") {
      setStatusMessage(`Completion list truncated${detail? ` (${detail})`:""}; keep typing to refine`);
    } else if(kind==="invalid-additional-edits") {
      setStatusMessage("Completion rejected invalid provider edits");
    } else if(kind==="identity-mismatch") {
      setStatusMessage("Completion discarded because the editor changed");
    } else {
      setStatusMessage(`Completion import unavailable${detail? ` (${detail})`:""}`);
    }
  },[setStatusMessage]);

  // ED-COMP-004 A3: an explicitly invoked completion that falls back for
  // missing scope facts names its prerequisite once. Silent unless the
  // workspace actually has a project story (a discovered build system or a
  // non-idle facts entry); plain loose-file editing stays quiet.
  const reportCompletionScopeFallback=useCallback((
    state: CompletionScopeFactsState,
  ) => {
    if(state.status!=="scope-facts-missing") return;
    const discoveredCount=projectDescriptorDiscovery.discovery?.descriptors?.length??0;
    const hasProjectStory=discoveredCount>0||projectFacts.status!=="idle";
    if(!hasProjectStory) return;
    setStatusMessage(`Completion project scope unavailable (${state.reason}); using document scope`);
  },[projectDescriptorDiscovery.discovery,projectFacts.status,setStatusMessage]);

  const getLspCompletions=useCallback(
    async (
      file: OpenFileState,
      position: LspPosition,
      triggerCharacter: string|null,
      token: CompletionRequestToken,
      // §8.19.4 repeated-call facts; forwarded to the provider adapter.
      invocation?: CompletionInvocationRequest,
    ): Promise<LspCompletionResult|null> => {
      // Always resolve against the live buffer (openFilesRef), not the React
      // prop — typing is batched into the store and the prop is often one
      // burst behind CodeMirror. Force-flush didChange so the server sees the
      // same text the caret is in (IDEA-like: no empty popup mid-edit).
      // Bail before any wait loop when this buffer has no usable language server.
      if(!shouldLiveSyncLsp(file.languagePath,lspFilesRef.current[file.key])) return null;
      const live=await ensureLspDocumentSynced(file.key,true);
      if(!live) return null;
      if(!isLspFeatureReady(lspFilesRef.current[live.key])) return null;
      if(openFilesRef.current[live.key]?.text!==live.text) return null;
      if(!isCompletionTokenCurrent(token)) return null;
      const descriptor=lspDescriptorForFile(live);
      if(!descriptor) return null;
      try {
        const result=await lspCompletion(descriptor,position,triggerCharacter,invocation);
        // Drop only when the buffer moved again while IPC was in flight; CM
        // re-queries on the next keystroke / incomplete list.
        if(!openFilesRef.current[live.key]) return null;
        if(openFilesRef.current[live.key]?.text!==live.text) return null;
        // Token identity must still match the live request origin; a stale
        // request from a switched file/restarted session is dropped here too.
        if(!isCompletionTokenCurrent(token)) return null;
        const currentLsp=lspFilesRef.current[live.key];
        if(
          !currentLsp?.status
          ||currentLsp.status.active!==result.status.active
          ||currentLsp.status.error!==result.status.error
        ) {
          updateLspStatusForFile(live,result.status);
        }
        return result;
      } catch {
        return null;
      }
    },
    [
      ensureLspDocumentSynced,
      isCompletionTokenCurrent,
      lspDescriptorForFile,
      updateLspStatusForFile,
    ],
  );

  const resolveLspCompletion=useCallback(
    async (
      file: OpenFileState,
      raw: unknown,
      token: CompletionRequestToken,
    ): Promise<LspCompletionResolveResult> => {
      const descriptor=lspDescriptorForFile(file);
      if(!descriptor) return { kind: "unavailable",reason: "no-document-descriptor" };
      if(!isCompletionTokenCurrent(token)) return { kind: "unavailable",reason: "stale-request" };
      const resolved=await lspCompletionResolve(descriptor,raw);
      return isCompletionTokenCurrent(token)? resolved:{ kind: "unavailable",reason: "stale-request" };
    },
    [isCompletionTokenCurrent,lspDescriptorForFile],
  );
  return { getLspCompletions,completionIdentityForFile,reportCompletionDiagnostic,reportCompletionScopeFallback,resolveLspCompletion };
}
