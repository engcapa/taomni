import { lspCancelReferenceRequest, lspHover, lspPrepareRename, lspReadUriContents, lspReferences, nextLspRequestSequence, type LspDiagnostic, type LspDocumentDescriptor, type LspDocumentStatus, type LspLocation, type LspPosition, type LspRange } from "../../../../lib/editor/lsp";
import { type BottomDockTabId, type EditorGroupId, type RightPaneTabId } from "../../../../stores/codeWorkspaceStore";
import { WorkspaceSemanticQueryHost, type SemanticQueryIdentity, type SemanticQueryKind, type SemanticQueryLiveGuards } from "../workspaceSemanticQueryHost";
import { type EditorSelectionRange } from "../CodeMirrorHost";
import { type WorkspaceIntelligencePreferences } from "../intelligencePreferences";
import { languageServiceReadiness } from "../languageServiceReadiness";
import { makeSemanticRequestIdentity } from "../javaSemanticEvidence";
import { type ReferencesResultState } from "../panels/ReferencesPanel";
import { executeHierarchyPrepare, type HierarchyRootState } from "../hierarchyQueryModel";
import { isDiagnosticScopeCurrent, type DiagnosticScope } from "../diagnosticScopeModel";
import { type QuickDocContent } from "../referenceDocumentation";
import { ReferenceInfoController, type ReferenceHistorySnapshot } from "../referenceInfoController";
import { libraryUriClassifierForRoots, UsageQuerySession, type UsagesScopeSelection } from "../usageQuerySession";
import { formatUsageEvidenceSuffix } from "../providerUsageEvidence";
import type { CodeWorkspaceFileRef, CodeWorkspaceLooseFileInfo, CodeWorkspaceRootInfo } from "../../../../types";
import { type LibraryBufferInfo, type LspFileState, type OpenFileState, errorMessage, fileKey, looksLikeDocumentUri, makeLooseFile, relativePathWithinRoot } from "../codeWorkspaceModel";
import { type LspLocationOpenOptions, semanticLocationsFromResult } from "./model";



export interface OpenHierarchyContext {
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  setStatusMessage: (message: string) => void;
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  cursorPositionsRef: import("react").RefObject<Record<string, LspPosition>>;
  activeEditorGroupId: string;
  editorSelectionRef: import("react").RefObject<EditorSelectionRange>;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  lspSessionGeneration: () => number;
  hierarchyRequestSequenceRef: import("react").RefObject<number>;
  workspaceInstanceId: string;
  workspaceInstanceIdRef: import("react").RefObject<string>;
  semanticQueryHostRef: import("react").RefObject<WorkspaceSemanticQueryHost>;
  projectAnalysisSnapshot: import("../projectAnalysisModel").JavaProjectAnalysisSnapshotV1 | null;
  updateLspStatusForFile: (file: OpenFileState, status: LspDocumentStatus) => void;
  hierarchyProvenanceRef: import("react").RefObject<Partial<Record<"call" | "type", { generation: number; projectFingerprint: string; }>>>;
  setHierarchyProvenanceRevision: import("react").Dispatch<import("react").SetStateAction<number>>;
  setCallHierarchyRoot: import("react").Dispatch<import("react").SetStateAction<HierarchyRootState | null>>;
  setBottomDockTab: (tab: BottomDockTabId | ((prev: BottomDockTabId) => BottomDockTabId)) => void;
  setTypeHierarchyRoot: import("react").Dispatch<import("react").SetStateAction<HierarchyRootState | null>>;
  setBottomDockOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
}


export function createOpenHierarchy(controllerContext: OpenHierarchyContext) {
  return async (mode: "call" | "type") => {
    const file = controllerContext.activeFile;
    if (!file || file.loading) return;
    const descriptor = controllerContext.lspDescriptorForFile(file);
    if (!descriptor) {
      controllerContext.setStatusMessage("No language service for this file");
      return;
    }
    const capabilities = controllerContext.lspFilesRef.current[file.key]?.status?.capabilities;
    const supported = mode === "call" ? capabilities?.callHierarchy : capabilities?.typeHierarchy;
    if (!supported) {
      controllerContext.setStatusMessage(`${mode === "call" ? "Call" : "Type"} hierarchy is not supported by this language server`);
      return;
    }
    let requestSequence = 0;
    try {
      const position = controllerContext.cursorPositionsRef.current[controllerContext.activeEditorGroupId] ?? controllerContext.editorSelectionRef.current.start;
      const fileKey = file.key;
      const docRevision = controllerContext.openFilesRef.current[fileKey]?.documentRevision ?? 0;
      const lspGen = controllerContext.lspSessionGeneration();
      requestSequence = ++controllerContext.hierarchyRequestSequenceRef.current;
      const requestId = `${controllerContext.workspaceInstanceId}:${mode}:prepare:${requestSequence}`;
      const cancelKey = `${controllerContext.workspaceInstanceId}|${fileKey}`;
      const requestSeq = nextLspRequestSequence();
      const isCurrent = (identity?: SemanticQueryIdentity) => (
        controllerContext.workspaceInstanceIdRef.current === controllerContext.workspaceInstanceId
        && controllerContext.hierarchyRequestSequenceRef.current === requestSequence
        && (!identity || identity.requestId === requestId)
        && controllerContext.openFilesRef.current[fileKey]?.documentRevision === docRevision
        && controllerContext.lspSessionGeneration() === lspGen
      );

      const prepareResult = await executeHierarchyPrepare(
        controllerContext.semanticQueryHostRef.current,
        descriptor,
        position,
        mode,
        {
          workspaceId: controllerContext.workspaceInstanceId,
          fileKey,
          documentRevision: docRevision,
          lspSessionGeneration: lspGen,
          projectFingerprint: controllerContext.projectAnalysisSnapshot?.projectFingerprint ?? "",
          requestId,
          cancelKey,
          requestSeq,
          guards: {
            getLiveDocumentRevision: () => controllerContext.openFilesRef.current[fileKey]?.documentRevision ?? 0,
            getLiveLspGeneration: () => controllerContext.lspSessionGeneration(),
            guardDelivery: (identity) => isCurrent(identity),
          },
        },
      );

      if (!isCurrent()) return;
      if (prepareResult.cancelled) return;
      controllerContext.updateLspStatusForFile(file, prepareResult.status);

      const root = prepareResult.root;
      if (!root) {
        controllerContext.setStatusMessage(`No ${mode} hierarchy is available at the cursor`);
        return;
      }
      if (!isCurrent()) return;
      controllerContext.hierarchyProvenanceRef.current = {
        ...controllerContext.hierarchyProvenanceRef.current,
        [mode]: {
          generation: lspGen,
          projectFingerprint: controllerContext.projectAnalysisSnapshot?.projectFingerprint ?? "",
        },
      };
      controllerContext.setHierarchyProvenanceRevision((revision) => revision + 1);
      if (mode === "call") {
        controllerContext.setCallHierarchyRoot(root);
        controllerContext.setBottomDockTab("call-hierarchy");
      } else {
        controllerContext.setTypeHierarchyRoot(root);
        controllerContext.setBottomDockTab("type-hierarchy");
      }
      controllerContext.setBottomDockOpen(true);
    } catch (cause) {
      if (
        requestSequence !== 0
        && (controllerContext.hierarchyRequestSequenceRef.current !== requestSequence
          || controllerContext.workspaceInstanceIdRef.current !== controllerContext.workspaceInstanceId)
      ) return;
      controllerContext.setStatusMessage(errorMessage(cause));
    }
  };
}



export interface OpenLspLocationContext {
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  suppressNextHistoryRecord: () => void;
  openFile: (ref: CodeWorkspaceFileRef, options?: { preview?: boolean; groupId?: EditorGroupId; activate?: boolean; restoring?: boolean; isCurrent?: () => boolean; }) => Promise<{ canonicalFileKey: string; groupId: string; error: string | null; } | null>;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  revealEditorLocation: (key: string, range: LspLocation["range"]) => void;
  recordNavigationLocation: (ref: CodeWorkspaceFileRef, position: import("../useWorkspaceNavigation").WorkspaceNavPosition, options?: { replaceSameFile?: boolean; }) => void;
  setLooseFiles: import("react").Dispatch<import("react").SetStateAction<CodeWorkspaceLooseFileInfo[]>>;
  setStatusMessage: (message: string) => void;
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  updateLspStatusForFile: (file: OpenFileState, status: LspDocumentStatus) => void;
  openLibraryBuffer: (info: LibraryBufferInfo, text: string, range: LspLocation["range"], options?: LspLocationOpenOptions) => Promise<boolean>;
}


export function createOpenLspLocation(controllerContext: OpenLspLocationContext) {
  return async (
      location: LspLocation,
      options: LspLocationOpenOptions = {},
    ) => {
      const openResolvedPath = async (path: string) => {
        if (options.isCurrent && !options.isCurrent()) return false;
        for (const root of controllerContext.rootsRef.current) {
          const relative = relativePathWithinRoot(root.path, path);
          if (relative === null) continue;
          const ref: CodeWorkspaceFileRef = { kind: "root", rootId: root.id, path: relative };
          if (options.isCurrent && !options.isCurrent()) return false;
          controllerContext.suppressNextHistoryRecord();
          await controllerContext.openFile(ref, options);
          if (options.isCurrent && !options.isCurrent()) return false;
          // openFile reports read failures on the buffer instead of throwing.
          if (controllerContext.openFilesRef.current[fileKey(ref)]?.error) return false;
          if (options.isCurrent && !options.isCurrent()) return false;
          controllerContext.revealEditorLocation(fileKey(ref), location.range);
          if (options.isCurrent && !options.isCurrent()) return false;
          const position = {
            line: location.range.start.line,
            character: location.range.start.character,
          };
          if (options.onRevealed) {
            options.onRevealed(ref, position);
          } else if (options.recordHistory !== false) {
            controllerContext.recordNavigationLocation(ref, position, { replaceSameFile: false });
          }
          return true;
        }
        const loose = makeLooseFile(path);
        const ref: CodeWorkspaceFileRef = { kind: "loose", id: loose.id, path: loose.path };
        if (options.isCurrent && !options.isCurrent()) return false;
        controllerContext.setLooseFiles((current) => current.some((item) => item.path === loose.path) ? current : [...current, loose]);
        controllerContext.suppressNextHistoryRecord();
        await controllerContext.openFile(ref, options);
        if (options.isCurrent && !options.isCurrent()) return false;
        // openFile reports read failures on the buffer instead of throwing.
        if (controllerContext.openFilesRef.current[fileKey(ref)]?.error) return false;
        if (options.isCurrent && !options.isCurrent()) return false;
        controllerContext.revealEditorLocation(fileKey(ref), location.range);
        if (options.isCurrent && !options.isCurrent()) return false;
        const position = {
          line: location.range.start.line,
          character: location.range.start.character,
        };
        if (options.onRevealed) {
          options.onRevealed(ref, position);
        } else if (options.recordHistory !== false) {
          controllerContext.recordNavigationLocation(ref, position, { replaceSameFile: false });
        }
        return true;
      };

      // Workspace-symbol hits fall back to the URI when the server reports no path,
      // and a URI string is never readable from disk.
      const diskPath = location.path && !looksLikeDocumentUri(location.path) ? location.path : null;
      if (diskPath) {
        try {
          if (await openResolvedPath(diskPath)) return true;
        } catch (err) {
          if (!location.uri) {
            controllerContext.setStatusMessage(errorMessage(err));
            return false;
          }
        }
        // Path unreadable (missing source attachment, JAR entry): try the URI below.
        if (!location.uri) return false;
      }

      // JDK / third-party JAR / other virtual URIs (jdt://, jar:file:…).
      if (!location.uri) {
        controllerContext.setStatusMessage("No definition found");
        return false;
      }
      // Library sources ride the origin project's language-server session: prefer the
      // active buffer, and fall back to the origin project of a library buffer.
      const origin = options.originFile
        ?? controllerContext.activeFile
        ?? Object.values(controllerContext.openFilesRef.current).find((item) => !item.loading)
        ?? null;
      const descriptor = origin ? controllerContext.lspDescriptorForFile(origin) : null;
      if (!origin || !descriptor) {
        controllerContext.setStatusMessage("Cannot open library source without an active language server document");
        return false;
      }
      try {
        const contents = await lspReadUriContents(descriptor, location.uri);
        if (options.isCurrent && !options.isCurrent()) return false;
        controllerContext.updateLspStatusForFile(origin, contents.status);
        // Attached sources that exist on disk open as a normal editable-looking file.
        if (contents.path) {
          try {
            if (await openResolvedPath(contents.path)) return true;
          } catch {
            // Keep going and inject the text we already fetched.
          }
        }
        return controllerContext.openLibraryBuffer(
          {
            uri: contents.uri || location.uri,
            title: contents.title,
            container: contents.container,
            languageId: contents.languageId,
            originRootPath: descriptor.rootPath ?? null,
            originFilePath: descriptor.filePath,
            decompiled: contents.decompiled,
          },
          contents.text,
          location.range,
          options,
        );
      } catch (err) {
        controllerContext.setStatusMessage(errorMessage(err));
        return false;
      }
    };
}



export interface OpenQuickDocumentationContext {
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  editorSelectionRef: import("react").RefObject<EditorSelectionRange>;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  setStatusMessage: (message: string) => void;
  showCodeInsightNotice: (message: string, action?: "configure" | null) => void;
  lspSessionGeneration: () => number;
  referenceInfoController: ReferenceInfoController;
  workspaceInstanceId: string;
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  updateLspStatusForFile: (file: OpenFileState, status: LspDocumentStatus) => void;
  setQuickDocContent: (content: QuickDocContent | null) => void;
  setReferenceHistory: import("react").Dispatch<import("react").SetStateAction<ReferenceHistorySnapshot>>;
  pinnedDoc: import("../referenceDocumentation").ReferenceContentEnvelope | null;
  pinnedDocLocked: boolean;
  setPinnedDoc: (content: QuickDocContent | null) => void;
  intelligencePreferences: WorkspaceIntelligencePreferences;
  setPinnedDocLocked: (locked: boolean) => void;
  setRightPaneTab: (tab: RightPaneTabId) => void;
  setRightPaneOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  setQuickDocOpen: (open: boolean) => void;
}


export function createOpenQuickDocumentation(controllerContext: OpenQuickDocumentationContext) {
  return async () => {
    const file = controllerContext.activeFile;
    if (!file || file.loading) return;
    const position = controllerContext.editorSelectionRef.current.start;
    const descriptor = controllerContext.lspDescriptorForFile(file);
    if (!descriptor) {
      controllerContext.setStatusMessage("No documentation available");
      controllerContext.showCodeInsightNotice("No documentation found.");
      return;
    }
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
    const word = line.slice(from, to) || file.title;
    // Display-only facts captured while the provider runs; the V3 payload
    // itself stays exactly {markdown, source}.
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
      // §8.18.6 provider cancellation: the abort reaches the native layer via
      // a per-file cancel key + monotonic seq so `$/cancelRequest` is sent
      // and the in-flight hover stops racing.
      const cancelKey = `${controllerContext.workspaceInstanceId}|${file.key}`;
      const requestSeq = nextLspRequestSequence();
      const onAbort = () => {
        void lspCancelReferenceRequest(cancelKey, requestSeq).catch(() => 0);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
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
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    });
    if (outcome.state !== "ready") {
      if (outcome.state === "unavailable") {
        controllerContext.setStatusMessage("No documentation available");
        // DEC-020-01: a popup at the caret names why (IDEA "No documentation found.").
        const readiness = languageServiceReadiness(controllerContext.lspFilesRef.current[file.key] ?? null);
        if (readiness.kind === "ready" || readiness.kind === "idle") controllerContext.showCodeInsightNotice("No documentation found.");
        else controllerContext.showCodeInsightNotice(`Documentation unavailable: ${readiness.message}`, readiness.action === "configure" ? "configure" : null);
      } else if (outcome.state === "failed") {
        controllerContext.setStatusMessage(outcome.message);
        controllerContext.showCodeInsightNotice(outcome.message);
      }
      return;
    }
    const payload = outcome.payload;
    if (payload.kind !== "quick-documentation") return;
    // History only records ready QuickDoc results; failed/unavailable never
    // enter it (§8.20.2).
    const content: QuickDocContent = {
      title: word,
      body: payload.markdown,
      source: providerLabel,
      uri: providerUri,
      sourceLocation: payload.source,
      revision: requestRevision,
      generation: requestGeneration,
    };
    controllerContext.setQuickDocContent(content);
    controllerContext.setReferenceHistory(controllerContext.referenceInfoController.pushHistory(content));
    if (controllerContext.pinnedDoc && !controllerContext.pinnedDocLocked) controllerContext.setPinnedDoc(content);
    if (controllerContext.intelligencePreferences.quickDoc.defaultTarget === "tool-window") {
      controllerContext.setPinnedDoc(content);
      controllerContext.setPinnedDocLocked(false);
      controllerContext.setRightPaneTab("documentation");
      controllerContext.setRightPaneOpen(true);
      controllerContext.setQuickDocOpen(false);
    } else {
      controllerContext.setQuickDocOpen(true);
    }
  };
}



export interface NavigateDiagnosticContext {
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  currentDiagnosticsForFile: (file: OpenFileState, state: LspFileState | null | undefined) => LspDiagnostic[] | null;
  setStatusMessage: (message: string) => void;
  diagnosticScopeForFile: (file: OpenFileState, state: LspFileState | null | undefined) => DiagnosticScope;
  displayDiagnosticsFor: (source: LspDiagnostic[] | null | undefined, path: string | undefined) => LspDiagnostic[];
  inspectionPathForFileKey: (fileKeyValue: string) => string;
  cursorPositionsRef: import("react").RefObject<Record<string, LspPosition>>;
  activeEditorGroupId: string;
  openFile: (ref: CodeWorkspaceFileRef, options?: { preview?: boolean; groupId?: EditorGroupId; activate?: boolean; restoring?: boolean; isCurrent?: () => boolean; }) => Promise<{ canonicalFileKey: string; groupId: string; error: string | null; } | null>;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  revealEditorLocation: (key: string, range: LspLocation["range"]) => void;
}


export function createNavigateDiagnostic(controllerContext: NavigateDiagnosticContext) {
  return (direction: 1 | -1) => {
    const file = controllerContext.activeFile;
    if (!file) return;
    const state = controllerContext.lspFilesRef.current[file.key] ?? null;
    const currentDiagnostics = controllerContext.currentDiagnosticsForFile(file, state);
    if (!currentDiagnostics) {
      controllerContext.setStatusMessage(state?.error
        ? `Diagnostics failed: ${state.error}`
        : state?.status?.active
          ? "Diagnostics are still refreshing for the current file"
          : "Diagnostics unavailable without a language server");
      return;
    }
    const requestScope = controllerContext.diagnosticScopeForFile(file, state);
    const diags = controllerContext.displayDiagnosticsFor(
      currentDiagnostics,
      controllerContext.inspectionPathForFileKey(file.key),
    ).filter((item) => item.severity === 1 || item.severity === 2).slice().sort((a, b) => {
      if (a.range.start.line !== b.range.start.line) {
        return a.range.start.line - b.range.start.line;
      }
      return a.range.start.character - b.range.start.character;
    });
    if (diags.length === 0) {
      controllerContext.setStatusMessage("No errors or warnings in current file");
      return;
    }

    const cursor = controllerContext.cursorPositionsRef.current[controllerContext.activeEditorGroupId] ?? { line: 0, character: 0 };
    const currentLine = cursor.line + 1;
    const currentColumn = cursor.character + 1;

    let targetIndex = -1;
    if (direction === 1) {
      targetIndex = diags.findIndex(
        (d) =>
          d.range.start.line + 1 > currentLine ||
          (d.range.start.line + 1 === currentLine && d.range.start.character + 1 > currentColumn),
      );
      if (targetIndex === -1) {
        targetIndex = 0;
      }
    } else {
      for (let i = diags.length - 1; i >= 0; i--) {
        const d = diags[i];
        if (
          d.range.start.line + 1 < currentLine ||
          (d.range.start.line + 1 === currentLine && d.range.start.character + 1 < currentColumn)
        ) {
          targetIndex = i;
          break;
        }
      }
      if (targetIndex === -1) {
        targetIndex = diags.length - 1;
      }
    }

    const target = diags[targetIndex];
    if (target) {
      void controllerContext.openFile(file.ref).then(() => {
        const latest = controllerContext.openFilesRef.current[file.key];
        const latestState = controllerContext.lspFilesRef.current[file.key] ?? null;
        const latestDiagnostics = latest
          ? controllerContext.currentDiagnosticsForFile(latest, latestState)
          : null;
        if (
          !latest
          || latest.documentRevision !== file.documentRevision
          || !isDiagnosticScopeCurrent(latestState?.diagnosticScope, requestScope)
          || !latestDiagnostics
          || !controllerContext.displayDiagnosticsFor(latestDiagnostics, controllerContext.inspectionPathForFileKey(file.key)).some((candidate) => (
            candidate.severity === target.severity
            && candidate.message === target.message
            && candidate.range.start.line === target.range.start.line
            && candidate.range.start.character === target.range.start.character
          ))
        ) {
          return;
        }
        controllerContext.revealEditorLocation(file.key, target.range);
      });
      controllerContext.setStatusMessage(`${target.severity === 1 ? "Error" : "Warning"}: ${target.message}`);
    }
  };
}



export interface RunFindReferencesContext {
  referencesRequestSequenceRef: import("react").RefObject<number>;
  setBottomDockOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  setBottomDockTab: (tab: BottomDockTabId | ((prev: BottomDockTabId) => BottomDockTabId)) => void;
  setReferencesResult: import("react").Dispatch<import("react").SetStateAction<ReferencesResultState>>;
  usageSessionRef: import("react").RefObject<UsageQuerySession | null>;
  semanticIndex: import("../useWorkspaceSemanticIndex").WorkspaceSemanticIndexController;
  ensureWorkspaceSemanticDocumentsSynced: (requiredFileKey: string, expectedRevision: number) => Promise<OpenFileState | null>;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  beginSemanticQuery: (kind: SemanticQueryKind, file: OpenFileState, descriptor: LspDocumentDescriptor, position: LspPosition) => { identity: SemanticQueryIdentity; cancelKey: string; requestSeq: number; guards: SemanticQueryLiveGuards; isCurrent: (candidate?: SemanticQueryIdentity) => boolean; lspOptions: (signal: AbortSignal) => { signal: AbortSignal; cancelKey: string; requestSeq: number; }; };
  workspaceInstanceId: string;
  lspSessionGeneration: () => number;
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  semanticQueryHostRef: import("react").RefObject<WorkspaceSemanticQueryHost>;
  updateLspStatusForFile: (file: OpenFileState, status: LspDocumentStatus) => void;
  referencesRerunRef: import("react").RefObject<{ fileKey: string; uri: string; position: LspPosition; symbolName: string; } | null>;
  projectAnalysisSnapshot: import("../projectAnalysisModel").JavaProjectAnalysisSnapshotV1 | null;
  setUsagesRecentsRevision: import("react").Dispatch<import("react").SetStateAction<number>>;
  setStatusMessage: (message: string) => void;
}


export function createRunFindReferences(controllerContext: RunFindReferencesContext) {
  return async (file: OpenFileState, position: LspPosition, selection: UsagesScopeSelection) => {
      controllerContext.referencesRequestSequenceRef.current += 1;
      const requestId = controllerContext.referencesRequestSequenceRef.current;
      controllerContext.setBottomDockOpen(true);
      controllerContext.setBottomDockTab("references");
      controllerContext.setReferencesResult({
        loading: true,
        origin: file.subtitle,
        locations: [],
        error: null,
        semanticGeneration: null,
        semanticRevision: null,
      });
      controllerContext.usageSessionRef.current?.startLoading(
        { uri: "", range: { start: position, end: position }, displayName: "", providerSymbolId: null },
        selection,
      );
      const expectedRevision = controllerContext.semanticIndex.current().revision;
      const live = await controllerContext.ensureWorkspaceSemanticDocumentsSynced(file.key, expectedRevision);
      if (!live) {
        if (controllerContext.referencesRequestSequenceRef.current !== requestId) return;
        controllerContext.setReferencesResult({
          loading: false,
          origin: file.subtitle,
          locations: [],
          error: "References require the language server to finish synchronizing current editor buffers",
          semanticGeneration: null,
          semanticRevision: null,
        });
        return;
      }
      const descriptor = controllerContext.lspDescriptorForFile(live);
      if (!descriptor) {
        if (controllerContext.referencesRequestSequenceRef.current === requestId) {
          controllerContext.setReferencesResult({
            loading: false,
            origin: file.subtitle,
            locations: [],
            error: "No language server is available for references",
            semanticGeneration: null,
            semanticRevision: null,
          });
        }
        return;
      }
      const buildToken = controllerContext.semanticIndex.beginBuild("language-server");
      let query: ReturnType<typeof controllerContext.beginSemanticQuery> | null = null;
      try {
        // §8.19.7 real identity + origin symbol key: name comes from the
        // provider's rename range when available (fallback: word at caret),
        // so rerun targets the same symbol rather than whatever sits under
        // the caret later.
        let symbolRange: LspRange | null = null;
        try {
          const prepared = await lspPrepareRename(descriptor, position);
          symbolRange = prepared.range ?? null;
        } catch {
          symbolRange = null;
        }
        if (controllerContext.referencesRequestSequenceRef.current !== requestId) {
          controllerContext.semanticIndex.abandonBuild(buildToken);
          return;
        }
        const lines = live.text.split("\n");
        const lineText = lines[position.line] ?? "";
        const symbolName = (symbolRange
          && symbolRange.start.line === symbolRange.end.line
          ? lineText.slice(symbolRange.start.character, symbolRange.end.character).trim()
          : "")
          || lineText.slice(position.character).match(/^[A-Za-z0-9_$]+/)?.[0]
          || "";
        const identity = makeSemanticRequestIdentity({
          workspaceId: controllerContext.workspaceInstanceId,
          fileKey: live.key,
          uri: descriptor.documentUri ?? descriptor.filePath,
          position,
          documentRevision: live.documentRevision ?? 0,
          providerGeneration: controllerContext.lspSessionGeneration(),
          workspaceRoots: controllerContext.rootsRef.current.map((root) => root.path),
        });
        const queryContext = controllerContext.beginSemanticQuery("references", live, descriptor, position);
        query = queryContext;
        // §8.20.5 W4 / §8.26.8 AA7: execute via SemanticQueryHost with cancellation and generation guard
        const queryRes = await controllerContext.semanticQueryHostRef.current.executeEnvelope<LspLocation>({
          kind: "references",
          identity: queryContext.identity,
          fetcher: async ({ signal }) => {
            const res = await lspReferences(
              descriptor,
              position,
              selection.includeDeclaration,
              queryContext.lspOptions(signal),
            );
            controllerContext.updateLspStatusForFile(live, res.status);
            return semanticLocationsFromResult(res);
          },
          guards: queryContext.guards,
        });
        if (queryRes.status === "cancelled" || queryRes.status === "stale") {
          controllerContext.semanticIndex.abandonBuild(buildToken);
          if (controllerContext.referencesRequestSequenceRef.current === requestId) {
            controllerContext.setReferencesResult({
              loading: false,
              origin: live.subtitle,
              locations: [],
              error: queryRes.status === "cancelled"
                ? "References request cancelled"
                : "References result became stale because the workspace changed",
              semanticGeneration: null,
              semanticRevision: null,
            });
          }
          return;
        }
        if (controllerContext.referencesRequestSequenceRef.current !== requestId) {
          controllerContext.semanticIndex.abandonBuild(buildToken);
          return;
        }
        if (!queryContext.isCurrent(queryRes.identity)) {
          controllerContext.semanticIndex.abandonBuild(buildToken);
          controllerContext.setReferencesResult({
            loading: false,
            origin: live.subtitle,
            locations: [],
            error: "References result became stale because the workspace changed",
            semanticGeneration: null,
            semanticRevision: null,
          });
          return;
        }
        if (queryRes.status === "unavailable" || queryRes.status === "error") {
          const message = queryRes.status === "error"
            ? queryRes.error ?? "Language server failed to find references"
            : "References are unavailable from the language server";
          controllerContext.semanticIndex.failBuild(buildToken, message);
          controllerContext.setReferencesResult({
            loading: false,
            origin: live.subtitle,
            locations: [],
            error: message,
            semanticGeneration: null,
            semanticRevision: null,
          });
          return;
        }
        const locations: readonly LspLocation[] = queryRes.items ?? [];
        const completion = controllerContext.semanticIndex.finishQuery(buildToken, {
          kind: "references",
          resultCount: locations.length,
        });
        if (!completion.accepted) {
          const message = "References result became stale because the workspace changed";
          controllerContext.setReferencesResult({
            loading: false,
            origin: live.subtitle,
            locations: [],
            error: message,
            semanticGeneration: null,
            semanticRevision: null,
          });
          return;
        }
        if (controllerContext.referencesRequestSequenceRef.current !== requestId || !queryContext.isCurrent()) return;
        controllerContext.referencesRerunRef.current = { fileKey: live.key, uri: identity.uri, position, symbolName };
        // §8.20.5 W4: freeze the scoped result into the shared session — the
        // tool window rows, the Show Usages popup and recents all read THIS
        // snapshot; nothing copies result truth elsewhere.
        const snapshot = controllerContext.usageSessionRef.current?.start({
          symbol: {
            uri: descriptor.documentUri ?? descriptor.filePath,
            range: symbolRange ?? { start: position, end: position },
            displayName: symbolName,
            providerSymbolId: null,
          },
          selection,
          evidence: {
            languageId: descriptor.languageId ?? "plaintext",
            provider: { id: "jdtls", version: null, generation: controllerContext.lspSessionGeneration() },
            projectFingerprint: controllerContext.projectAnalysisSnapshot?.projectFingerprint ?? identity.projectFingerprint,
            uri: identity.uri,
            revision: live.documentRevision ?? 0,
            scope: "project",
          },
          locations,
          isLibraryUri: libraryUriClassifierForRoots(controllerContext.rootsRef.current, relativePathWithinRoot),
          workspaceRoots: controllerContext.rootsRef.current.map((root) => root.path),
          usageCompleteness: "complete",
        }) ?? null;
        if (controllerContext.referencesRequestSequenceRef.current !== requestId || !queryContext.isCurrent()) return;
        const scopedLocations = (snapshot?.envelope.results ?? []).map(({ role: _role, ...location }) => location);
        controllerContext.setUsagesRecentsRevision((revision) => revision + 1);
        controllerContext.setReferencesResult({
          loading: false,
          origin: live.subtitle,
          locations: scopedLocations,
          error: null,
          semanticGeneration: buildToken.generation,
          semanticRevision: buildToken.revision,
          symbolName,
          identity,
        });
        controllerContext.setStatusMessage(`${scopedLocations.length} reference${scopedLocations.length === 1 ? "" : "s"} found${scopedLocations.length !== locations.length ? ` (${locations.length} unscoped)` : ""}${formatUsageEvidenceSuffix(snapshot?.usageEvidence ?? null)}`);
      } catch (err) {
        if (
          controllerContext.referencesRequestSequenceRef.current !== requestId
          || (query !== null && !query.isCurrent())
        ) {
          controllerContext.semanticIndex.abandonBuild(buildToken);
          return;
        }
        controllerContext.semanticIndex.failBuild(buildToken, errorMessage(err));
        if (controllerContext.referencesRequestSequenceRef.current !== requestId) return;
        controllerContext.setReferencesResult({
          loading: false,
          origin: file.subtitle,
          locations: [],
          error: errorMessage(err),
          semanticGeneration: null,
          semanticRevision: null,
        });
      }
    };
}
