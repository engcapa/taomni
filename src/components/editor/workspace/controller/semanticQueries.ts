import { lspDocumentHighlights, lspDeclaration, lspCancelReferenceRequest, lspHover, lspPrepareRename, lspSignatureHelp, lspWorkspaceSymbols, nextLspRequestSequence, type LspDocumentDescriptor, type LspDocumentHighlight, type LspLocation, type LspPosition } from "../../../../lib/editor/lsp";
import { WorkspaceSemanticQueryHost, type SemanticQueryIdentity, type SemanticQueryKind, type SemanticQueryLiveGuards } from "../workspaceSemanticQueryHost";
import { writeText } from "../../../../lib/clipboard";
import { type EditorSelectionRange } from "../CodeMirrorHost";
import { copyReferenceCandidates } from "../workspaceCopyReference";
import { fallbackWordHighlights, wordAt } from "../lspIntelligenceChrome";
import type { MenuItem } from "../../../ContextMenu";
import { createOccurrenceSession, formatOccurrenceStatus, type OccurrenceHighlightSession } from "../occurrenceHighlightModel";
import { type QuickDocContent } from "../referenceDocumentation";
import { ReferenceInfoController } from "../referenceInfoController";
import { useProjectFactsStore } from "../../../../stores/projectFactsStore";
import { selectQueryProjectGeneration } from "../projectFactsConsumers";
import { type GoToSymbolQueryResult } from "../SearchEverywhere";
import type { CodeWorkspaceFileRef, CodeWorkspaceRootInfo } from "../../../../types";
import { type LspFileState, type OpenFileState, absoluteWorkspacePath, emptyLspFileState, errorMessage, isLspFeatureReady, shouldLiveSyncLsp, fsPathEquals } from "../codeWorkspaceModel";
import { semanticLocationsFromResult, isDeclarationDefinitionEquivalentLanguage } from "./model";


export interface BeginSemanticQueryContext {
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  lspSessionGeneration: () => number;
  workspaceInstanceId: string;
  semanticQuerySequenceRef: import("react").RefObject<number>;
  semanticQueryLatestRequestRef: import("react").RefObject<Record<string, string>>;
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  projectFactsRoot: string;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  workspaceInstanceIdRef: import("react").RefObject<string>;
}


export function createBeginSemanticQuery(controllerContext: BeginSemanticQueryContext): (kind: SemanticQueryKind, file: OpenFileState, descriptor: LspDocumentDescriptor, position: LspPosition) => { identity: SemanticQueryIdentity; cancelKey: string; requestSeq: number; guards: SemanticQueryLiveGuards; isCurrent: (candidate?: SemanticQueryIdentity) => boolean; lspOptions: (signal: AbortSignal) => { signal: AbortSignal; cancelKey: string; requestSeq: number; }; } {
  return (
    kind: SemanticQueryKind,
    file: OpenFileState,
    descriptor: LspDocumentDescriptor,
    position: LspPosition,
  ) => {
    const documentRevision = controllerContext.openFilesRef.current[file.key]?.documentRevision ?? file.documentRevision;
    const capturedLspSessionGeneration = controllerContext.lspSessionGeneration();
    const requestId = `${controllerContext.workspaceInstanceId}:${kind}:${++controllerContext.semanticQuerySequenceRef.current}`;
    controllerContext.semanticQueryLatestRequestRef.current[kind] = requestId;
    const cancelKey = `${controllerContext.workspaceInstanceId}|${file.key}`;
    const requestSeq = nextLspRequestSequence();
    // ED-PROJECT-005: pin the ready project-facts generation into the query
    // identity so facts invalidation stales the in-flight request with zero
    // downstream effect. Files without ready same-workspace facts pin nothing
    // and run scope-less instead of leaking a foreign generation.
    // (Mirrors absolutePathForOpenFile: library buffers have no host path.)
    let queryFileAbsPath: string | null = null;
    const queryRef = file.ref;
    if (!file.library) {
      if (queryRef.kind === "loose") {
        queryFileAbsPath = queryRef.path;
      } else {
        const queryRoot = controllerContext.rootsRef.current.find((root) => root.id === queryRef.rootId);
        if (queryRoot) queryFileAbsPath = absoluteWorkspacePath(queryRoot, queryRef.path);
      }
    }
    const capturedFactsGeneration = selectQueryProjectGeneration(controllerContext.projectFactsRoot, queryFileAbsPath);
    const identity: SemanticQueryIdentity = {
      workspaceId: controllerContext.workspaceInstanceId,
      fileKey: file.key,
      uri: descriptor.documentUri ?? descriptor.filePath,
      position,
      documentRevision,
      lspSessionGeneration: capturedLspSessionGeneration,
      ...(capturedFactsGeneration !== undefined ? { projectGeneration: capturedFactsGeneration } : {}),
      requestId,
    };
    const isCurrent = (candidate?: SemanticQueryIdentity): boolean => {
      const current = controllerContext.openFilesRef.current[file.key];
      const currentDescriptor = current ? controllerContext.lspDescriptorForFile(current) : null;
      const currentUri = currentDescriptor?.documentUri ?? currentDescriptor?.filePath;
      return controllerContext.workspaceInstanceIdRef.current === controllerContext.workspaceInstanceId
        && controllerContext.semanticQueryLatestRequestRef.current[kind] === requestId
        && (!candidate || candidate.requestId === requestId)
        && current != null
        && current.documentRevision === documentRevision
        && currentUri === identity.uri
        && controllerContext.lspSessionGeneration() === capturedLspSessionGeneration;
    };
    const guards: SemanticQueryLiveGuards = {
      getLiveDocumentRevision: () => controllerContext.openFilesRef.current[file.key]?.documentRevision ?? -1,
      getLiveLspGeneration: () => controllerContext.lspSessionGeneration(),
      getLiveProjectGeneration: () => useProjectFactsStore.getState().getWorkspaceFacts(controllerContext.projectFactsRoot).generation,
      guardDelivery: (candidate) => isCurrent(candidate),
    };
    return {
      identity,
      cancelKey,
      requestSeq,
      guards,
      isCurrent,
      lspOptions: (signal: AbortSignal) => ({ signal, cancelKey, requestSeq }),
    };
  };
}



export interface FetchWorkspaceSymbolsContext {
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  semanticIndex: import("../useWorkspaceSemanticIndex").WorkspaceSemanticIndexController;
  ensureWorkspaceSemanticDocumentsSynced: (requiredFileKey: string, expectedRevision: number) => Promise<OpenFileState | null>;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  updateLspStatusForFile: (file: OpenFileState, status: import("../../../../lib/editor/lsp").LspDocumentStatus) => void;
}


export function createFetchWorkspaceSymbols(controllerContext: FetchWorkspaceSymbolsContext): (query: string) => Promise<GoToSymbolQueryResult> {
  return async (query: string): Promise<GoToSymbolQueryResult> => {
    const file = controllerContext.activeFile ?? Object.values(controllerContext.openFilesRef.current).find((item) => !item.loading) ?? null;
    const unavailable = (): GoToSymbolQueryResult => {
      return {
        symbols: [],
        semanticGeneration: null,
        semanticRevision: null,
        sessionCount: 0,
        providerCount: 0,
        skippedProviderCount: 0,
        failedProviderCount: 0,
        complete: false,
        truncated: false,
        diagnostics: [],
      };
    };
    if (!file) return unavailable();
    const expectedRevision = controllerContext.semanticIndex.current().revision;
    const live = await controllerContext.ensureWorkspaceSemanticDocumentsSynced(file.key, expectedRevision);
    if (!live) return unavailable();
    const descriptor = controllerContext.lspDescriptorForFile(live);
    if (!descriptor) return unavailable();
    const buildToken = controllerContext.semanticIndex.beginBuild("language-server");
    try {
      const result = await lspWorkspaceSymbols(descriptor, query);
      controllerContext.updateLspStatusForFile(live, result.status);
      const symbols = result.symbols.map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        containerName: symbol.containerName,
        path: symbol.path ?? symbol.uri,
        uri: symbol.uri,
        line: symbol.selectionRange.start.line,
        character: symbol.selectionRange.start.character,
        resolved: symbol.resolved,
        resolveToken: symbol.resolveToken ?? null,
      }));
      const completion = controllerContext.semanticIndex.finishQuery(buildToken, {
        kind: "symbols",
        resultCount: symbols.length,
        coverage: {
          scope: "workspace",
          sessionCount: result.sessionCount,
          providerCount: result.providerCount,
          skippedProviderCount: result.skippedProviderCount,
          failedProviderCount: result.failedProviderCount,
          complete: result.complete,
          truncated: result.truncated,
          diagnostics: result.diagnostics ?? [],
        },
      });
      return completion.accepted
        ? {
          symbols,
          semanticGeneration: buildToken.generation,
          semanticRevision: buildToken.revision,
          sessionCount: result.sessionCount,
          providerCount: result.providerCount,
          skippedProviderCount: result.skippedProviderCount,
          failedProviderCount: result.failedProviderCount,
          complete: result.complete,
          truncated: result.truncated,
          diagnostics: result.diagnostics ?? [],
        }
        : unavailable();
    } catch (error) {
      controllerContext.semanticIndex.failBuild(buildToken, errorMessage(error));
      return unavailable();
    }
  };
}



export interface CopyReferenceAtCursorContext {
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  editorSelectionRef: import("react").RefObject<EditorSelectionRange>;
  setStatusMessage: (message: string) => void;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  editorPaneRef: import("react").RefObject<HTMLElement | null>;
  openTreeContextMenuAt: (x: number, y: number, items: MenuItem[], menuOptions?: import("../../../ContextMenu").ContextMenuAppearance) => void;
}


export function createCopyReferenceAtCursor(controllerContext: CopyReferenceAtCursorContext): () => Promise<void> {
  return async () => {
    const file = controllerContext.activeFile;
    if (!file) return;
    const path = controllerContext.absolutePathForOpenFile(file);
    const outcome = copyReferenceCandidates({
      path,
      isLibrary: !!file.library,
      roots: controllerContext.rootsRef.current.map((root) => root.path),
      line: controllerContext.editorSelectionRef.current.start.line,
      symbolName: null,
    });
    if (outcome.kind === "unavailable") {
      controllerContext.setStatusMessage(`Copy Reference unavailable (${outcome.reason}): ${outcome.detail}`);
      return;
    }
    // Best-effort provider symbol identity; failure degrades to path-only
    // rather than blocking the copy.
    let symbolName: string | null = null;
    if (!file.library) {
      try {
        const live = controllerContext.openFilesRef.current[file.key];
        const descriptor = live ? controllerContext.lspDescriptorForFile(live) : null;
        if (descriptor) {
          const position = controllerContext.editorSelectionRef.current.start;
          const prepared = await lspPrepareRename(descriptor, position);
          const range = prepared.range ?? null;
          const lineText = live?.text.split("\n")[position.line] ?? "";
          symbolName = (range && range.start.line === range.end.line
            ? lineText.slice(range.start.character, range.end.character).trim()
            : "")
            || lineText.slice(position.character).match(/^[A-Za-z0-9_$]+/)?.[0]
            || null;
        }
      } catch {
        symbolName = null;
      }
    }
    const final = symbolName
      ? copyReferenceCandidates({
        path,
        isLibrary: !!file.library,
        roots: controllerContext.rootsRef.current.map((root) => root.path),
        line: controllerContext.editorSelectionRef.current.start.line,
        symbolName,
      })
      : outcome;
    if (final.kind === "unavailable") {
      controllerContext.setStatusMessage(`Copy Reference unavailable (${final.reason}): ${final.detail}`);
      return;
    }
    if (final.candidates.length === 1) {
      await writeText(final.candidates[0].text);
      controllerContext.setStatusMessage(`Copied reference: ${final.candidates[0].text}`);
      return;
    }
    const rect = controllerContext.editorPaneRef.current?.getBoundingClientRect();
    controllerContext.openTreeContextMenuAt(
      (rect?.left ?? 0) + 80,
      (rect?.top ?? 0) + 80,
      final.candidates.map((candidate) => ({
        label: `${candidate.label}: ${candidate.text}`,
        onClick: () => {
          void writeText(candidate.text).then(() => {
            controllerContext.setStatusMessage(`Copied reference: ${candidate.text}`);
          });
        },
      })),
    );
  };
}



export interface HighlightUsagesInFileContext {
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  occurrenceRequestGenerationRef: import("react").RefObject<number>;
  autoHighlightRequestGenerationRef: import("react").RefObject<number>;
  cursorPositionsRef: import("react").RefObject<Record<string, LspPosition>>;
  activeEditorGroupId: string;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  lspDocumentEpochRef: import("react").RefObject<Record<string, number>>;
  activeCapabilities: import("../../../../lib/editor/lsp").LspCapabilitySummary | null;
  activeLspDocumentIsSynced: boolean;
  occurrenceActiveFileKeyRef: import("react").RefObject<string | null>;
  occurrenceActiveGroupIdRef: import("react").RefObject<string>;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  isCurrentLspDocumentRequest: (file: OpenFileState, epoch: number) => boolean;
  setStatusMessage: (message: string) => void;
  setOccurrenceSession: import("react").Dispatch<import("react").SetStateAction<OccurrenceHighlightSession | null>>;
  occurrenceSessionRef: import("react").RefObject<OccurrenceHighlightSession | null>;
  setHighlightsByGroupNow: import("react").Dispatch<import("react").SetStateAction<Record<string, LspDocumentHighlight[]>>>;
}


export function createHighlightUsagesInFile(controllerContext: HighlightUsagesInFileContext): () => Promise<void> {
  return async () => {
    const file = controllerContext.activeFile;
    if (!file) return;
    const requestGeneration = ++controllerContext.occurrenceRequestGenerationRef.current;
    // A manual request supersedes any cursor-driven request that is still in
    // flight. Its response may not overwrite the explicit session afterward.
    controllerContext.autoHighlightRequestGenerationRef.current += 1;
    // The caret state commits in a transition; Ctrl+Shift+F7 right after a
    // caret move must use the position the editor reported synchronously.
    const position = controllerContext.cursorPositionsRef.current[controllerContext.activeEditorGroupId] ?? { line: 0, character: 0 };
    const descriptor = controllerContext.lspDescriptorForFile(file);
    const rev = controllerContext.lspDocumentEpochRef.current[file.key] ?? 0;
    const needsLiveLspCheck = Boolean(
      controllerContext.activeCapabilities?.documentHighlight && descriptor && controllerContext.activeLspDocumentIsSynced,
    );
    const canApply = () => (
      controllerContext.occurrenceRequestGenerationRef.current === requestGeneration
      && controllerContext.occurrenceActiveFileKeyRef.current === file.key
      && controllerContext.occurrenceActiveGroupIdRef.current === controllerContext.activeEditorGroupId
      && controllerContext.openFilesRef.current[file.key]?.text === file.text
      && (!needsLiveLspCheck || controllerContext.isCurrentLspDocumentRequest(file, rev))
    );
    const lines = file.text.split("\n");
    let offset = 0;
    for (let l = 0; l < Math.min(position.line, lines.length); l += 1) {
      offset += lines[l].length + 1;
    }
    offset += Math.min(position.character, lines[position.line]?.length ?? 0);
    const token = wordAt(file.text, offset);
    const word = token?.word || "symbol";

    let highlights: LspDocumentHighlight[] = [];
    if (controllerContext.activeCapabilities?.documentHighlight && descriptor && controllerContext.activeLspDocumentIsSynced) {
      try {
        const result = await lspDocumentHighlights(descriptor, position);
        highlights = result.highlights;
      } catch {
        highlights = fallbackWordHighlights(file.text, position);
      }
    } else {
      highlights = fallbackWordHighlights(file.text, position);
    }

    if (!canApply()) return;
    if (highlights.length === 0) {
      controllerContext.setStatusMessage(`No occurrences found for "${word}"`);
      controllerContext.setOccurrenceSession(null);
      controllerContext.occurrenceSessionRef.current = null;
      return;
    }

    const session = createOccurrenceSession(file.key, rev, word, highlights, position);
    controllerContext.setOccurrenceSession(session);
    controllerContext.occurrenceSessionRef.current = session;
    // An explicit action paints with its status message; only caret-driven
    // highlighting renders as a transition.
    controllerContext.setHighlightsByGroupNow((current) => ({
      ...current,
      [controllerContext.activeEditorGroupId]: highlights,
    }));
    controllerContext.setStatusMessage(formatOccurrenceStatus(session));
  };
}



export interface ParameterInfoProviderContext {
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  ensureLspDocumentSynced: (fileKey: string, requireSynchronized?: boolean) => Promise<OpenFileState | null>;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  workspaceInstanceId: string;
  lspSessionGeneration: () => number;
  updateLspStatusForFile: (file: OpenFileState, status: import("../../../../lib/editor/lsp").LspDocumentStatus) => void;
}


export function createParameterInfoProvider(controllerContext: ParameterInfoProviderContext): (request: { fileKey: string; uri: string; position: LspPosition; documentRevision: number; providerGeneration: number; }, triggerCharacter: string | null, { signal }: { signal: AbortSignal; }) => Promise<{ state: "payload"; payload: { kind: "parameter-info"; signatures: import("../../../../lib/editor/lsp").LspSignatureInfo[]; activeSignature: number; activeParameter: number; }; } | null> {
  return async (
      request: { fileKey: string; uri: string; position: LspPosition; documentRevision: number; providerGeneration: number },
      triggerCharacter: string | null,
      { signal }: { signal: AbortSignal },
    ) => {
      const file = controllerContext.openFilesRef.current[request.fileKey];
      if (!file) return null;
      if (!shouldLiveSyncLsp(file.languagePath, controllerContext.lspFilesRef.current[file.key])) return null;
      const live = await controllerContext.ensureLspDocumentSynced(file.key);
      if (!live) return null;
      if (!isLspFeatureReady(controllerContext.lspFilesRef.current[live.key])) return null;
      const descriptor = controllerContext.lspDescriptorForFile(live);
      if (!descriptor) return null;
      const cancelKey = `${controllerContext.workspaceInstanceId}|${file.key}`;
      const requestSeq = nextLspRequestSequence();
      const onAbort = () => {
        void lspCancelReferenceRequest(cancelKey, requestSeq).catch(() => 0);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await lspSignatureHelp(
          descriptor,
          request.position,
          triggerCharacter ?? null,
          { cancelKey, requestSeq },
        );
        if (signal.aborted) return null;
        const current = controllerContext.openFilesRef.current[live.key];
        if (
          !current
          || current.documentRevision !== request.documentRevision
          || controllerContext.lspSessionGeneration() !== request.providerGeneration
        ) {
          return null;
        }
        controllerContext.updateLspStatusForFile(live, result.status);
        if (!result.signatures.length || !result.status.active) return null;
        return {
          state: "payload" as const,
          payload: {
            kind: "parameter-info" as const,
            signatures: result.signatures,
            activeSignature: result.activeSignature,
            activeParameter: result.activeParameter,
          },
        };
      } catch {
        // Request-level failures close the popup quietly; the next explicit
        // action or trigger re-queries.
        return null;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    };
}



export interface GetLspHoverContext {
  debugRef: import("react").RefObject<import("../useCodeDebugSession").CodeDebugSession | null>;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  lspSessionGeneration: () => number;
  referenceInfoController: ReferenceInfoController;
  workspaceInstanceId: string;
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  updateLspStatusForFile: (file: OpenFileState, status: import("../../../../lib/editor/lsp").LspDocumentStatus) => void;
  setLspFiles: (updater: Record<string, LspFileState> | ((prev: Record<string, LspFileState>) => Record<string, LspFileState>)) => void;
}


export function createGetLspHover(controllerContext: GetLspHoverContext): (file: OpenFileState, position: LspPosition) => Promise<QuickDocContent | null> {
  return async (file: OpenFileState, position: LspPosition): Promise<QuickDocContent | null> => {
      // While the debugger is stopped in this file, the hover belongs to the
      // debugger (IDEA shows the value, not the javadoc). Read through the ref:
      // the debug hook is declared later in this component.
      const session = controllerContext.debugRef.current;
      if (session?.state?.status === "stopped") {
        const stoppedPath = session.currentLocation?.path;
        const filePath = controllerContext.absolutePathForOpenFile(file);
        if (stoppedPath && filePath && fsPathEquals(stoppedPath, filePath)) {
          return null;
        }
      }
      const descriptor = controllerContext.lspDescriptorForFile(file);
      if (!descriptor) return null;
      const requestRevision = file.documentRevision;
      const requestGeneration = controllerContext.lspSessionGeneration();
      const lines = file.text.split("\n");
      const line = lines[position.line] ?? "";
      const left = line.slice(0, position.character);
      const right = line.slice(position.character);
      const start = left.search(/[A-Za-z0-9_$]+$/);
      const endMatch = right.match(/^[A-Za-z0-9_$]*/);
      const from = start >= 0 ? start : position.character;
      const to = position.character + (endMatch?.[0].length ?? 0);
      let providerLabel = "Language Server";
      let providerUri: string | null = null;
      const outcome = await controllerContext.referenceInfoController.requestTyped({
        kind: "quick-documentation",
        workspaceId: controllerContext.workspaceInstanceId,
        fileKey: file.key,
        uri: descriptor.documentUri ?? controllerContext.lspFilesRef.current[file.key]?.status?.uri ?? descriptor.filePath,
        languageId: descriptor.languageId ?? "plaintext",
        position,
        documentRevision: requestRevision,
        providerGeneration: requestGeneration,
      }, async ({ signal }) => {
        // §8.18.6: same provider-cancellation identity as the explicit path.
        const cancelKey = `${controllerContext.workspaceInstanceId}|${file.key}`;
        const requestSeq = nextLspRequestSequence();
        const result = await lspHover(descriptor, position, { cancelKey, requestSeq });
        if (signal.aborted) return null;
        const current = controllerContext.openFilesRef.current[file.key];
        if (
          !current
          || current.documentRevision !== requestRevision
          || controllerContext.lspSessionGeneration() !== requestGeneration
        ) {
          return null;
        }
        controllerContext.updateLspStatusForFile(file, result.status);
        if (!result.contents) return null;
        providerLabel = result.status.displayName ?? "Language Server";
        providerUri = result.status.uri ?? null;
        return {
          state: "payload" as const,
          payload: {
            kind: "quick-documentation" as const,
            markdown: result.contents,
            source: result.range && result.status.uri
              ? {
                  uri: result.status.uri,
                  path: result.status.path ?? null,
                  range: result.range,
                }
              : null,
          },
        };
      });
      if (outcome.state !== "ready" || outcome.payload.kind !== "quick-documentation") {
        if (outcome.state === "failed") {
          controllerContext.setLspFiles((current) => ({
            ...current,
            [file.key]: {
              ...(current[file.key] ?? emptyLspFileState()),
              error: outcome.state === "failed" ? outcome.message : "",
            },
          }));
        }
        return null;
      }
      // Hover refreshes the cursor-linked popup but never writes history —
      // only ready explicit QuickDoc does (§8.20.2).
      return {
        title: line.slice(from, to) || file.title,
        body: outcome.payload.markdown,
        source: providerLabel,
        uri: providerUri,
        sourceLocation: outcome.payload.source,
        revision: requestRevision,
        generation: requestGeneration,
      };
    };
}



export interface GoToDeclarationContext {
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  goToDefinition: (file: OpenFileState, position: LspPosition) => Promise<boolean>;
  prepareSemanticNavigationRequest: (file: OpenFileState) => Promise<{ file: OpenFileState; descriptor: LspDocumentDescriptor; } | null>;
  setStatusMessage: (message: string) => void;
  beginSemanticQuery: (kind: SemanticQueryKind, file: OpenFileState, descriptor: LspDocumentDescriptor, position: LspPosition) => { identity: SemanticQueryIdentity; cancelKey: string; requestSeq: number; guards: SemanticQueryLiveGuards; isCurrent: (candidate?: SemanticQueryIdentity) => boolean; lspOptions: (signal: AbortSignal) => { signal: AbortSignal; cancelKey: string; requestSeq: number; }; };
  semanticQueryHostRef: import("react").RefObject<WorkspaceSemanticQueryHost>;
  updateLspStatusForFile: (file: OpenFileState, status: import("../../../../lib/editor/lsp").LspDocumentStatus) => void;
  navigateLocations: (title: string, locations: LspLocation[], emptyMessage: string, isCurrent?: () => boolean, origin?: { file: OpenFileState; ref: CodeWorkspaceFileRef; position: LspPosition; }) => Promise<boolean>;
}


export function createGoToDeclaration(controllerContext: GoToDeclarationContext): (file: OpenFileState, position: LspPosition) => Promise<boolean> {
  return async (file: OpenFileState, position: LspPosition) => {
      // Languages whose declaration is the definition (Java, Kotlin, …) go
      // straight to the definition query. Preparing here first forced a second
      // buffer sync inside goToDefinition, which could supersede the query and
      // drop Ctrl+B silently (ED-PARITY-013: Ctrl+B is now the navigation key).
      const current = controllerContext.openFilesRef.current[file.key] ?? file;
      const currentLanguageId = controllerContext.lspFilesRef.current[current.key]?.status?.languageId
        ?? controllerContext.lspDescriptorForFile(current)?.languageId
        ?? current.languagePath;
      if (isDeclarationDefinitionEquivalentLanguage(currentLanguageId, current.path)) {
        return controllerContext.goToDefinition(current, position);
      }
      const prepared = await controllerContext.prepareSemanticNavigationRequest(file);
      if (!prepared) return false;
      const { file: live, descriptor } = prepared;
      const caps = controllerContext.lspFilesRef.current[live.key]?.status?.capabilities;
      if (caps && caps.declaration === false) {
        if (caps.definition !== false) {
          return controllerContext.goToDefinition(live, position);
        }
        controllerContext.setStatusMessage("Go to declaration is not supported by this language server");
        return false;
      }
      try {
        const query = controllerContext.beginSemanticQuery("declarations", live, descriptor, position);
        const queryRes = await controllerContext.semanticQueryHostRef.current.executeEnvelope<LspLocation>({
          kind: "declarations",
          identity: query.identity,
          fetcher: async ({ signal }) => {
            const result = await lspDeclaration(descriptor, position, query.lspOptions(signal));
            controllerContext.updateLspStatusForFile(live, result.status);
            return semanticLocationsFromResult(result);
          },
          guards: query.guards,
        });
        if (queryRes.status === "stale" || queryRes.status === "cancelled") {
          return false;
        }
        if (!query.isCurrent(queryRes.identity)) return false;
        if (queryRes.status === "unavailable" || queryRes.status === "error") {
          if (caps?.definition !== false) {
            return controllerContext.goToDefinition(live, position);
          }
          controllerContext.setStatusMessage(queryRes.error ?? "No declaration found");
          return false;
        }
        if (queryRes.items.length === 0 && caps?.definition !== false) {
          return controllerContext.goToDefinition(live, position);
        }
        return controllerContext.navigateLocations(
          "Declarations",
          queryRes.items,
          "No declaration found",
          query.isCurrent,
          { file: live, ref: live.ref, position },
        );
      } catch (err) {
        if (caps?.definition !== false) {
          return controllerContext.goToDefinition(live, position);
        }
        controllerContext.setStatusMessage(errorMessage(err));
        return false;
      }
    };
}
