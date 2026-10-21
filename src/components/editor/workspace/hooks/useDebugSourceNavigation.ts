import { useCallback, useEffect, useRef } from "react";
import { type LspDocumentDescriptor, type LspLocation } from "../../../../lib/editor/lsp";
import { type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceFileRef } from "../../../../types";
import { type LibraryBufferInfo, type OpenFileState, fileKey } from "../codeWorkspaceModel";
import { type DebugStackFrame } from "../dapDebugModel";


export interface UseDebugSourceNavigationContext {
  problemPathToRef: (rawPath: string) => CodeWorkspaceFileRef | null;
  openFile: (ref: CodeWorkspaceFileRef, options?: { preview?: boolean; groupId?: EditorGroupId; activate?: boolean; restoring?: boolean; isCurrent?: () => boolean; }) => Promise<{ canonicalFileKey: string; groupId: string; error: string | null; } | null>;
  revealEditorLocation: (key: string, range: LspLocation["range"]) => void;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  activeKey: string | null;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  debugRef: import("react").RefObject<import("../useCodeDebugSession").CodeDebugSession | null>;
  setStatusMessage: (message: string) => void;
  openLibraryBuffer: (info: LibraryBufferInfo, text: string, range: LspLocation["range"], options?: import("../controller/model").LspLocationOpenOptions) => Promise<boolean>;
  debug: import("../useCodeDebugSession").CodeDebugSession;
  showDebugExecutionPointRef: import("react").RefObject<() => void>;
}

export function useDebugSourceNavigation(context: UseDebugSourceNavigationContext) {
  const {
    problemPathToRef,
    openFile,
    revealEditorLocation,
    openFilesRef,
    activeKey,
    lspDescriptorForFile,
    debugRef,
    setStatusMessage,
    openLibraryBuffer,
    debug,
    showDebugExecutionPointRef,
  } = context;

  const openDebugFrame = useCallback((
    frame: Pick<DebugStackFrame, "path" | "line"> & Partial<Pick<DebugStackFrame, "sourceReference" | "sourceName" | "name">> & { column?: number; },
  ) => {
    // D11.1: line/column arrive 1-based; convert to 0-based exactly once here
    const line0 = frame.line - 1;
    const char0 = (frame.column ?? 1) - 1;
    const range = { start: { line: line0, character: char0 }, end: { line: line0, character: char0 } };
    const ref = frame.path ? problemPathToRef(frame.path) : null;
    if (ref) {
      void openFile(ref).then(() => revealEditorLocation(fileKey(ref), range));
      return;
    }
    // Outside the workspace (JDK / a dependency JAR): ask the adapter for the
    // attached or decompiled source and show it read-only, like IDEA does.
    const sourceReference = frame.sourceReference ?? 0;
    if (sourceReference <= 0) return;
    const origin = openFilesRef.current[activeKey ?? ""]
      ?? Object.values(openFilesRef.current).find((item) => !item.loading)
      ?? null;
    const descriptor = origin ? lspDescriptorForFile(origin) : null;
    if (!descriptor) return;
    void (async () => {
      const text = await debugRef.current?.fetchSource(sourceReference);
      if (!text) {
        setStatusMessage("No source available for this frame");
        return;
      }
      const title = frame.sourceName ?? `${frame.name ?? "frame"}.java`;
      await openLibraryBuffer(
        {
          uri: `dap-source:${sourceReference}/${title}`,
          title,
          container: frame.name ?? null,
          languageId: "java",
          originRootPath: descriptor.rootPath ?? null,
          originFilePath: descriptor.filePath,
          decompiled: true,
        },
        text,
        range,
      );
    })();
  }, [
    activeKey, lspDescriptorForFile, openFile, openLibraryBuffer, problemPathToRef,
    revealEditorLocation, setStatusMessage,
  ]);

  // IDEA-style: jump to the stopped location (breakpoint hit / step landing)
  // automatically, once per distinct location.
  const debugRevealRef = useRef<string | null>(null);
  useEffect(() => {
    const loc = debug.currentLocation;
    if (!loc || debug.state?.status !== "stopped") {
      debugRevealRef.current = null;
      return;
    }
    const key = `${loc.path}:${loc.line}`;
    if (debugRevealRef.current === key) return;
    debugRevealRef.current = key;
    openDebugFrame({ path: loc.path, line: loc.line });
  }, [debug.currentLocation, debug.state?.status, openDebugFrame]);
  showDebugExecutionPointRef.current = () => {
    const state = debug.state;
    const frame = state?.frames.find((candidate) => candidate.id === state.selectedFrameId) ?? state?.frames[0];
    if (frame && (frame.path || frame.sourceReference > 0)) openDebugFrame(frame);
  };
  return { openDebugFrame };
}
