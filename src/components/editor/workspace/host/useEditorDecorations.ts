import { useCallback, useEffect, useRef } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { indentUnit } from "@codemirror/language";
import { createDiagnosticChrome } from "../lspDiagnosticChrome";
import { setErrorStripeSources } from "../errorStripe";
import { setRunGutter, type RunGutterTarget } from "../runGutter";
import { updateLspOverlayChrome, updateLspSemanticTokenChrome } from "../lspIntelligenceChrome";
import { updateGitEditorChrome } from "../gitEditorChrome";
import { type DebugBreakpointMarker } from "../debugEditorChrome";
import { createCoverageEditorChrome } from "../coverageEditorChrome";
import { sameArrayOrBothEmpty, sameInlineValues } from "./reconciliation";


export interface UseEditorDecorationsContext {
  viewRef: import("react").RefObject<EditorView | null>;
  diagnostics: import("../../../../lib/editor/lsp").LspDiagnostic[];
  onLightbulbRef: import("react").RefObject<((line: number) => void) | undefined>;
  highlights: import("../../../../lib/editor/lsp").LspDocumentHighlight[];
  inlayHints: import("../../../../lib/editor/lsp").LspInlayHint[];
  gitChanges: import("../gitEditorChrome").GitLineChange[];
  onRunGutterClickRef: import("react").RefObject<((target: RunGutterTarget, anchor: { x: number; y: number; }) => void) | undefined>;
  runGutterTargets: RunGutterTarget[];
  codeStyle: import("../codeStyleModel").EffectiveCodeStyle | undefined;
  semanticTokens: import("../../../../lib/editor/lsp").LspSemanticToken[];
  gitBlame: import("../../../../lib/git").GitBlameLine | null;
  onGitChangeClickRef: import("react").RefObject<((change: import("../gitEditorChrome").GitLineChange) => void) | undefined>;
  fileCoverage: import("../coverageModel").FileCoverage | null | undefined;
  coverageEnabled: boolean;
  debugEvaluate: ((expression: string) => Promise<{ value: string; type: string | null; } | null>) | null | undefined;
  debugBreakpoints: DebugBreakpointMarker[];
  debugCurrentLine: number | null | undefined;
  debugInlineValues: Record<string, string>;
  buildDebugChrome: (markers: DebugBreakpointMarker[] | undefined, currentLine: number | null | undefined, inlineValues: Record<string, string> | undefined, evaluating: boolean) => Extension;
}

export function useEditorDecorations(context: UseEditorDecorationsContext) {
  const {
    viewRef,
    diagnostics,
    onLightbulbRef,
    highlights,
    inlayHints,
    gitChanges,
    onRunGutterClickRef,
    runGutterTargets,
    codeStyle,
    semanticTokens,
    gitBlame,
    onGitChangeClickRef,
    fileCoverage,
    coverageEnabled,
    debugEvaluate,
    debugBreakpoints,
    debugCurrentLine,
    debugInlineValues,
    buildDebugChrome,
  } = context;

  const codeStyleCompartment = useRef(new Compartment());
  const diagnosticsCompartment = useRef(new Compartment());
  const coverageCompartment = useRef(new Compartment());
  const debugCompartment = useRef(new Compartment());
  const renderedDiagnosticsRef = useRef(diagnostics);
  const renderedCodeStyleRef = useRef({
    tabSize: codeStyle?.tabSize ?? 2,
    insertSpaces: codeStyle?.insertSpaces ?? true,
    indentSize: codeStyle?.indentSize || (codeStyle?.tabSize ?? 2),
  });
  const renderedCoverageRef = useRef({ fileCoverage, coverageEnabled });
  const renderedOverlayRef = useRef({ highlights, inlayHints });
  const renderedSemanticTokensRef = useRef(semanticTokens);
  const renderedGitRef = useRef({ changes: gitChanges, blame: gitBlame });
  const renderedStripeRef = useRef({ diagnostics, gitChanges, usages: highlights });
  const pendingGitUpdateFrameRef = useRef<number | null>(null);
  const renderedDebugRef = useRef({
    breakpoints: debugBreakpoints,
    currentLine: debugCurrentLine,
    inlineValues: debugInlineValues,
    evaluating: !!debugEvaluate,
  });


  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (sameArrayOrBothEmpty(renderedDiagnosticsRef.current, diagnostics)) return;
    renderedDiagnosticsRef.current = diagnostics;
    view.dispatch({
      effects: diagnosticsCompartment.current.reconfigure(createDiagnosticChrome(
        diagnostics,
        (line) => onLightbulbRef.current?.(line),
      )),
    });
  }, [diagnostics]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const previous = renderedOverlayRef.current;
    if (
      sameArrayOrBothEmpty(previous.highlights, highlights)
      && sameArrayOrBothEmpty(previous.inlayHints, inlayHints)
    ) {
      return;
    }
    renderedOverlayRef.current = { highlights, inlayHints };
    view.dispatch({
      effects: updateLspOverlayChrome(highlights, inlayHints),
    });
  }, [highlights, inlayHints]);

  // The stripe is secondary chrome: update it after the frame so document and
  // decoration transactions keep their single synchronous dispatch.
  useEffect(() => {
    const previous = renderedStripeRef.current;
    if (sameArrayOrBothEmpty(previous.diagnostics, diagnostics)
      && sameArrayOrBothEmpty(previous.gitChanges, gitChanges)
      && sameArrayOrBothEmpty(previous.usages, highlights)) return;
    const frame = window.requestAnimationFrame(() => {
      const view = viewRef.current;
      if (!view || !view.dom.isConnected) return;
      renderedStripeRef.current = { diagnostics, gitChanges, usages: highlights };
      view.dispatch({
        effects: setErrorStripeSources.of({ diagnostics, gitChanges, usages: highlights }),
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [diagnostics, gitChanges, highlights]);

  const runGutterClick = useCallback(
    (target: RunGutterTarget, anchor: { x: number; y: number; }) => onRunGutterClickRef.current?.(target, anchor),
    [],
  );
  const renderedRunGutterRef = useRef(runGutterTargets);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || renderedRunGutterRef.current === runGutterTargets) return;
    renderedRunGutterRef.current = runGutterTargets;
    view.dispatch({ effects: setRunGutter.of({ targets: runGutterTargets, onClick: runGutterClick }) });
  }, [runGutterClick, runGutterTargets]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const tabSize = codeStyle?.tabSize ?? 2;
    const insertSpaces = codeStyle?.insertSpaces ?? true;
    const indentSize = codeStyle?.indentSize || tabSize;
    const prev = renderedCodeStyleRef.current;
    if (prev.tabSize === tabSize && prev.insertSpaces === insertSpaces && prev.indentSize === indentSize) {
      return;
    }
    renderedCodeStyleRef.current = { tabSize, insertSpaces, indentSize };
    view.dispatch({
      effects: codeStyleCompartment.current.reconfigure([
        EditorState.tabSize.of(tabSize),
        indentUnit.of(insertSpaces ? " ".repeat(indentSize) : "\t"),
      ]),
    });
  }, [codeStyle?.tabSize, codeStyle?.indentSize, codeStyle?.insertSpaces]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (sameArrayOrBothEmpty(renderedSemanticTokensRef.current, semanticTokens)) return;
    renderedSemanticTokensRef.current = semanticTokens;
    view.dispatch({
      effects: updateLspSemanticTokenChrome(semanticTokens),
    });
  }, [semanticTokens]);

  useEffect(() => {
    const previous = renderedGitRef.current;
    if (sameArrayOrBothEmpty(previous.changes, gitChanges) && previous.blame === gitBlame) return;
    const frame = window.requestAnimationFrame(() => {
      if (pendingGitUpdateFrameRef.current !== frame) return;
      pendingGitUpdateFrameRef.current = null;
      const view = viewRef.current;
      if (!view || !view.dom.isConnected) return;
      renderedGitRef.current = { changes: gitChanges, blame: gitBlame };
      view.dispatch({
        effects: updateGitEditorChrome(
          gitChanges,
          gitBlame,
          (change) => onGitChangeClickRef.current?.(change),
        ),
      });
    });
    pendingGitUpdateFrameRef.current = frame;
    return () => {
      if (pendingGitUpdateFrameRef.current !== frame) return;
      window.cancelAnimationFrame(frame);
      pendingGitUpdateFrameRef.current = null;
    };
  }, [gitBlame, gitChanges]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const prev = renderedCoverageRef.current;
    if (prev.fileCoverage === fileCoverage && prev.coverageEnabled === coverageEnabled) {
      return;
    }
    renderedCoverageRef.current = { fileCoverage, coverageEnabled };
    view.dispatch({
      effects: coverageCompartment.current.reconfigure(
        createCoverageEditorChrome(fileCoverage ?? null, coverageEnabled),
      ),
    });
  }, [fileCoverage, coverageEnabled]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const previous = renderedDebugRef.current;
    const evaluating = !!debugEvaluate;
    if (
      sameArrayOrBothEmpty(previous.breakpoints ?? [], debugBreakpoints ?? [])
      && previous.currentLine === debugCurrentLine
      && sameInlineValues(previous.inlineValues, debugInlineValues)
      && previous.evaluating === evaluating
    ) {
      return;
    }
    renderedDebugRef.current = {
      breakpoints: debugBreakpoints,
      currentLine: debugCurrentLine,
      inlineValues: debugInlineValues,
      evaluating,
    };
    view.dispatch({
      effects: debugCompartment.current.reconfigure(buildDebugChrome(
        debugBreakpoints,
        debugCurrentLine,
        debugInlineValues,
        evaluating,
      )),
    });
  }, [buildDebugChrome, debugBreakpoints, debugCurrentLine, debugEvaluate, debugInlineValues]);
  return { codeStyleCompartment, diagnosticsCompartment, coverageCompartment, debugCompartment, renderedDiagnosticsRef, renderedCodeStyleRef, renderedCoverageRef, renderedOverlayRef, renderedSemanticTokensRef, renderedGitRef, pendingGitUpdateFrameRef, renderedDebugRef };
}
