import { useCallback, useMemo, useState } from "react";
import { type EditorSelectionRange } from "../host/types";
import { type OpenFileState, fsPathEquals, normalizeFsPath } from "../codeWorkspaceModel";
import { type DebugBreakpoint } from "../dapDebugModel";

export interface UseBreakpointControlsContext {
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  debug: import("../useCodeDebugSession").CodeDebugSession;
  rootRef: import("react").RefObject<HTMLDivElement | null>;
  toggleActiveBreakpointRef: import("react").RefObject<(line: number) => void>;
  editActiveBreakpointRef: import("react").RefObject<(line: number) => void>;
  viewBreakpointsAtCaretRef: import("react").RefObject<(line: number) => void>;
  addActiveBreakpointRef: import("react").RefObject<(line: number, options: Partial<DebugBreakpoint>) => void>;
  toggleActiveBreakpointEnabledRef: import("react").RefObject<(line: number) => void>;
  toggleTemporaryBreakpointRef: import("react").RefObject<(line: number) => void>;
  openEvaluateDialogRef: import("react").RefObject<(expression?: string) => void>;
  editorSelectionRef: import("react").RefObject<EditorSelectionRange>;
}

export function useBreakpointControls(context: UseBreakpointControlsContext) {
  const {
    activeFile,
    absolutePathForOpenFile,
    debug,
    rootRef,
    toggleActiveBreakpointRef,
    editActiveBreakpointRef,
    viewBreakpointsAtCaretRef,
    addActiveBreakpointRef,
    toggleActiveBreakpointEnabledRef,
    toggleTemporaryBreakpointRef,
    openEvaluateDialogRef,
    editorSelectionRef,
  } = context;
  /** Breakpoint whose editor is open in the Debug panel's breakpoints view. */
  const [editingBreakpoint, setEditingBreakpoint] = useState<{ path: string; line: number } | null>(null);
  const activeFileAbsPath = activeFile ? absolutePathForOpenFile(activeFile) : null;
  const debugSessionActive = !!debug.state && debug.state.status !== "terminated";
  const activeDebugCurrentLine = useMemo<number | null>(() => {
    const loc = debug.currentLocation;
    if (!loc || !activeFileAbsPath) return null;
    return fsPathEquals(loc.path, activeFileAbsPath) ? loc.line : null;
  }, [activeFileAbsPath, debug.currentLocation]);
  /** The editor is showing the stopped frame: inline values + hover apply here. */
  const debugStoppedHere = debug.state?.status === "stopped" && activeDebugCurrentLine != null;
  const debugRunToCursorLine = useCallback((line: number) => {
    if (activeFileAbsPath) debug.runToCursor(normalizeFsPath(activeFileAbsPath), line);
  }, [activeFileAbsPath, debug]);
  const toggleActiveBreakpoint = useCallback((line: number) => {
    if (activeFileAbsPath) debug.toggleBreakpoint(normalizeFsPath(activeFileAbsPath), line);
  }, [activeFileAbsPath, debug]);

  /** IDEA's breakpoint balloon (gutter right-click / Ctrl+Shift+F8 on a breakpoint). */
  const [breakpointPopup, setBreakpointPopup] = useState<{
    path: string;
    line: number;
    anchor: { x: number; y: number };
    expanded: boolean;
  } | null>(null);
  /** IDEA's View Breakpoints dialog, optionally opened on one breakpoint. */
  const [breakpointsDialog, setBreakpointsDialog] = useState<{ initial: { path: string; line: number } | null } | null>(null);
  /** IDEA's Evaluate dialog (Alt+F8). */
  const [evaluateDialog, setEvaluateDialog] = useState<{ expression: string } | null>(null);
  const [gutterMenu, setGutterMenu] = useState<{ path: string; line: number; x: number; y: number } | null>(null);

  /** The caret row's gutter, where IDEA anchors the keyboard-opened popup. */
  const caretGutterAnchor = useCallback((): { x: number; y: number } => {
    const scope = rootRef.current ?? document;
    const row = scope.querySelector<HTMLElement>(".cm-editor.cm-focused .cm-activeLineGutter")
      ?? scope.querySelector<HTMLElement>(".cm-editor .cm-activeLineGutter")
      ?? scope.querySelector<HTMLElement>(".cm-editor .cm-activeLine");
    const rect = row?.getBoundingClientRect();
    if (rect && (rect.width > 0 || rect.height > 0)) return { x: rect.left, y: rect.bottom };
    return { x: Math.round(window.innerWidth / 3), y: Math.round(window.innerHeight / 3) };
  }, []);

  const openBreakpointPopup = useCallback((
    path: string,
    line: number,
    anchor?: { x: number; y: number },
    expanded = false,
  ) => {
    setGutterMenu(null);
    setBreakpointPopup({ path, line, anchor: anchor ?? caretGutterAnchor(), expanded });
  }, [caretGutterAnchor]);

  /**
   * Right-click a breakpoint (or Ctrl+Shift+F8 on its line): create it if
   * needed and open IDEA's breakpoint balloon next to the gutter.
   */
  const editActiveBreakpoint = useCallback((line: number, anchor?: { x: number; y: number }) => {
    if (!activeFileAbsPath) return;
    const key = normalizeFsPath(activeFileAbsPath);
    if (!(debug.breakpoints[key] ?? []).some((bp) => bp.line === line)) {
      debug.toggleBreakpoint(key, line);
    }
    openBreakpointPopup(key, line, anchor);
  }, [activeFileAbsPath, debug, openBreakpointPopup]);
  toggleActiveBreakpointRef.current = toggleActiveBreakpoint;
  editActiveBreakpointRef.current = editActiveBreakpoint;
  viewBreakpointsAtCaretRef.current = (line: number) => {
    const key = activeFileAbsPath ? normalizeFsPath(activeFileAbsPath) : null;
    if (key && (debug.breakpoints[key] ?? []).some((bp) => bp.line === line)) {
      openBreakpointPopup(key, line);
      return;
    }
    setBreakpointPopup(null);
    setBreakpointsDialog({ initial: null });
  };
  addActiveBreakpointRef.current = (line, options) => {
    if (activeFileAbsPath) debug.addBreakpoint(normalizeFsPath(activeFileAbsPath), line, options);
  };
  toggleActiveBreakpointEnabledRef.current = (line) => {
    if (activeFileAbsPath) debug.toggleBreakpointEnabled(normalizeFsPath(activeFileAbsPath), line);
  };
  // IDEA Ctrl+Alt+Shift+F8: remove an existing breakpoint, else add a
  // Remove-once-hit one.
  toggleTemporaryBreakpointRef.current = (line) => {
    if (!activeFileAbsPath) return;
    const key = normalizeFsPath(activeFileAbsPath);
    if ((debug.breakpoints[key] ?? []).some((bp) => bp.line === line)) debug.removeBreakpoint(key, line);
    else debug.addBreakpoint(key, line, { temporary: true });
  };
  openEvaluateDialogRef.current = (expression?: string) => {
    const selected = expression ?? editorSelectionRef.current.text?.trim() ?? "";
    setEvaluateDialog({ expression: selected.includes("\n") ? "" : selected });
  };
  return {
    debugSessionActive,
    openBreakpointPopup,
    setBreakpointPopup,
    setGutterMenu,
    debugRunToCursorLine,
    debugStoppedHere,
    editingBreakpoint,
    setEditingBreakpoint,
    setBreakpointsDialog,
    activeFileAbsPath,
    breakpointPopup,
    gutterMenu,
    breakpointsDialog,
    evaluateDialog,
    setEvaluateDialog,
  };
}
