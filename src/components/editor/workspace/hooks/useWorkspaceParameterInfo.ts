import { useCallback, useEffect } from "react";
import { type LspDocumentDescriptor, type LspPosition } from "../../../../lib/editor/lsp";
import { type LspFileState, type OpenFileState } from "../codeWorkspaceModel";
import { createParameterInfoProvider } from "../controller/semanticQueries";
import { type ParameterInvalidateReason, type ReferenceSessionContext } from "../referenceInfoSession";


export interface UseWorkspaceParameterInfoContext {
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  ensureLspDocumentSynced: (fileKey: string, requireSynchronized?: boolean) => Promise<OpenFileState | null>;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  workspaceInstanceId: string;
  lspSessionGeneration: () => number;
  updateLspStatusForFile: (file: OpenFileState, status: import("../../../../lib/editor/lsp").LspDocumentStatus) => void;
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  parameterInfoSession: import("../referenceInfoSession").ParameterInfoSession;
}

export function useWorkspaceParameterInfo(context: UseWorkspaceParameterInfoContext) {
  const {
    openFilesRef,
    lspFilesRef,
    ensureLspDocumentSynced,
    lspDescriptorForFile,
    workspaceInstanceId,
    lspSessionGeneration,
    updateLspStatusForFile,
    activeFile,
    parameterInfoSession,
  } = context;

  // §8.20.2 W1 Parameter single channel: the provider adapter behind the
  // session. The controller owns identity/cancel; this closure only talks to
  // the language server through the §8.18.6 cancel bridge.
  const parameterInfoProvider = useCallback(
    createParameterInfoProvider({
      openFilesRef,
      lspFilesRef,
      ensureLspDocumentSynced,
      lspDescriptorForFile,
      workspaceInstanceId,
      lspSessionGeneration,
      updateLspStatusForFile,
    }),
    [
      ensureLspDocumentSynced,
      lspDescriptorForFile,
      lspSessionGeneration,
      updateLspStatusForFile,
      workspaceInstanceId,
    ],
  );

  /** Live file identity snapshot feeding the session's stale/closure checks.
   * Reads through openFilesRef: a typed edit bumps the revision synchronously
   * there, while the rendered OpenFileState can lag one flush behind. */
  const sessionContextForFile = useCallback((file: OpenFileState): ReferenceSessionContext | null => {
    const latest = openFilesRef.current[file.key] ?? file;
    if (latest.loading) return null;
    const descriptor = lspDescriptorForFile(latest);
    return {
      fileKey: latest.key,
      uri: descriptor?.documentUri
        ?? lspFilesRef.current[latest.key]?.status?.uri
        ?? descriptor?.filePath
        ?? latest.languagePath,
      languageId: descriptor?.languageId ?? "plaintext",
      documentRevision: latest.documentRevision,
      providerGeneration: lspSessionGeneration(),
    };
  }, [lspDescriptorForFile, lspSessionGeneration]);

  // File switches (and workspace remounts) close the old tooltip; per-edit
  // closure comes from the host's doc-changed/caret invalidation events.
  const activeParameterFileKey = activeFile?.key ?? null;
  useEffect(() => {
    if (!activeParameterFileKey) {
      parameterInfoSession.setContext(null);
      return;
    }
    const latest = openFilesRef.current[activeParameterFileKey];
    if (!latest) return;
    const context = sessionContextForFile(latest);
    if (context) parameterInfoSession.setContext(context);
  }, [activeParameterFileKey, parameterInfoSession, sessionContextForFile]);

  const handleParameterTrigger = useCallback((file: OpenFileState, event: {
    position: LspPosition;
    anchorOffset: number;
    triggerCharacter: string | null;
    origin: "explicit" | "typing";
  }) => {
    const context = sessionContextForFile(file);
    if (!context) return;
    // The edit that carried the trigger also bumped the identity; publishing
    // it here closes any pre-edit tooltip before the fresh query starts.
    parameterInfoSession.setContext(context);
    parameterInfoSession.request(event, (request, ticket) =>
      parameterInfoProvider(request, event.triggerCharacter, ticket));
  }, [parameterInfoProvider, parameterInfoSession, sessionContextForFile]);

  const handleParameterInvalidate = useCallback((reason: ParameterInvalidateReason) => {
    parameterInfoSession.invalidate(reason);
  }, [parameterInfoSession]);

  const handleParameterEscape = useCallback(() => parameterInfoSession.escape(), [parameterInfoSession]);
  return { handleParameterTrigger, handleParameterInvalidate, handleParameterEscape };
}
