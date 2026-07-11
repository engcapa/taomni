import { useEffect, useRef, type MutableRefObject } from "react";
import { Compartment, EditorState, type Extension, type Text } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  crosshairCursor,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  hoverTooltip,
  keymap,
  lineNumbers,
  rectangularSelection,
  type DecorationSet,
  type Tooltip,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import { bracketMatching, foldGutter, indentOnInput } from "@codemirror/language";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { renderFormatted } from "../../../lib/chat/renderFormatted";
import { codeViewExtensions } from "../../../lib/codeViewTheme";
import type {
  LspDiagnostic,
  LspPosition,
} from "../../../lib/editor/lsp";
import { languageForPath } from "../../git/diffLanguage";
import { createWorkspaceSearchPanel, WORKSPACE_SEARCH_STYLE } from "./editorSearchPanel";
import { selectionHistoryField, workspaceEditorKeymap } from "./workspaceEditorCommands";

interface EditorRevealTarget {
  line: number;
  character: number;
}

interface CodeMirrorHostProps {
  path: string;
  doc: string;
  visible: boolean;
  diagnostics: LspDiagnostic[];
  reveal: EditorRevealTarget | null;
  onChange: (doc: string) => void;
  onSave: () => void;
  onHover: (position: LspPosition) => Promise<string | null>;
  onDefinition: (position: LspPosition) => Promise<boolean>;
  onReferences: (position: LspPosition) => Promise<void>;
}

const WORKSPACE_EDITOR_STYLE = EditorView.theme({
  "&": {
    height: "100%",
  },
  ".cm-foldGutter .cm-gutterElement": {
    minWidth: "1.6ch",
    padding: "0 4px",
  },
});

const LSP_EDITOR_STYLE = EditorView.theme({
  ".cm-lsp-diagnostic-error": {
    textDecoration: "underline wavy #ef4444 1px",
    textUnderlineOffset: "2px",
  },
  ".cm-lsp-diagnostic-warning": {
    textDecoration: "underline wavy #f59e0b 1px",
    textUnderlineOffset: "2px",
  },
  ".cm-lsp-diagnostic-info": {
    textDecoration: "underline dotted #38bdf8 1px",
    textUnderlineOffset: "2px",
  },
  ".cm-lsp-hover": {
    maxWidth: "520px",
    maxHeight: "320px",
    overflow: "auto",
    padding: "8px 10px",
    border: "1px solid var(--taomni-code-border)",
    background: "var(--taomni-code-tooltip-bg)",
    color: "var(--taomni-code-text)",
    boxShadow: "0 12px 28px rgba(0, 0, 0, 0.28)",
    fontSize: "12px",
    lineHeight: "1.5",
  },
});

function offsetFromLspPosition(doc: Text, position: LspPosition): number {
  if (doc.lines === 0) return 0;
  const lineNo = Math.min(doc.lines, Math.max(1, position.line + 1));
  const line = doc.line(lineNo);
  return Math.min(line.to, line.from + Math.max(0, position.character));
}

function lspPositionFromOffset(doc: Text, offset: number): LspPosition {
  const line = doc.lineAt(Math.max(0, Math.min(doc.length, offset)));
  return {
    line: line.number - 1,
    character: offset - line.from,
  };
}

function diagnosticClass(severity: number | null): string {
  if (severity === 1) return "cm-lsp-diagnostic-error";
  if (severity === 2) return "cm-lsp-diagnostic-warning";
  return "cm-lsp-diagnostic-info";
}

function diagnosticDecorations(view: EditorView, diagnostics: LspDiagnostic[]): DecorationSet {
  const ranges = diagnostics.flatMap((diagnostic) => {
    const from = offsetFromLspPosition(view.state.doc, diagnostic.range.start);
    const rawTo = offsetFromLspPosition(view.state.doc, diagnostic.range.end);
    const to = Math.max(rawTo, Math.min(view.state.doc.length, from + 1));
    if (from > view.state.doc.length || to < from) return [];
    return Decoration.mark({
      class: diagnosticClass(diagnostic.severity),
      attributes: { title: diagnostic.message },
    }).range(from, to);
  });
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(ranges, true);
}

function lspDiagnosticsExtension(diagnostics: LspDiagnostic[]): Extension {
  return EditorView.decorations.of((view) => diagnosticDecorations(view, diagnostics));
}

function lspInteractionExtensions(
  hoverRef: MutableRefObject<(position: LspPosition) => Promise<string | null>>,
  definitionRef: MutableRefObject<(position: LspPosition) => Promise<boolean>>,
  referencesRef: MutableRefObject<(position: LspPosition) => Promise<void>>,
): Extension[] {
  const definitionAtSelection = (view: EditorView) => {
    const position = lspPositionFromOffset(view.state.doc, view.state.selection.main.head);
    void definitionRef.current(position);
    return true;
  };
  const referencesAtSelection = (view: EditorView) => {
    const position = lspPositionFromOffset(view.state.doc, view.state.selection.main.head);
    void referencesRef.current(position);
    return true;
  };
  return [
    hoverTooltip((view, pos): Promise<Tooltip | null> => {
      const position = lspPositionFromOffset(view.state.doc, pos);
      return hoverRef.current(position).then((contents) => {
        if (!contents) return null;
        return {
          pos,
          above: true,
          create() {
            const dom = document.createElement("div");
            dom.className = "cm-lsp-hover taomni-chat-md";
            dom.innerHTML = renderFormatted(contents, "md") ?? "";
            return { dom };
          },
        };
      });
    }),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0 || (!event.ctrlKey && !event.metaKey)) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        event.preventDefault();
        void definitionRef.current(lspPositionFromOffset(view.state.doc, pos));
        return true;
      },
    }),
    keymap.of([
      { key: "F12", run: definitionAtSelection },
      { key: "Shift-F12", run: referencesAtSelection },
    ]),
  ];
}

export function CodeMirrorHost({
  path,
  doc,
  visible,
  diagnostics,
  reveal,
  onChange,
  onSave,
  onHover,
  onDefinition,
  onReferences,
}: CodeMirrorHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartment = useRef(new Compartment());
  const diagnosticsCompartment = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onHoverRef = useRef(onHover);
  const onDefinitionRef = useRef(onDefinition);
  const onReferencesRef = useRef(onReferences);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onHoverRef.current = onHover;
  onDefinitionRef.current = onDefinition;
  onReferencesRef.current = onReferences;

  useEffect(() => {
    if (!hostRef.current) return;
    const saveHandler = () => {
      onSaveRef.current();
      return true;
    };
    const openReplacePanel = (view: EditorView) => {
      openSearchPanel(view);
      window.requestAnimationFrame(() => {
        const field = view.dom.querySelector<HTMLInputElement>('.cm-workspace-search-input[name="replace"]');
        field?.focus();
        field?.select();
      });
      return true;
    };
    const state = EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        foldGutter(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        EditorState.allowMultipleSelections.of(true),
        drawSelection(),
        rectangularSelection({
          eventFilter: (event) =>
            event.button === 0 && (event.altKey || (event.ctrlKey && event.shiftKey)),
        }),
        crosshairCursor(),
        history(),
        bracketMatching(),
        closeBrackets(),
        indentOnInput(),
        autocompletion(),
        search({ top: true, createPanel: createWorkspaceSearchPanel }),
        selectionHistoryField,
        languageCompartment.current.of([]),
        diagnosticsCompartment.current.of(lspDiagnosticsExtension(diagnostics)),
        ...lspInteractionExtensions(onHoverRef, onDefinitionRef, onReferencesRef),
        ...codeViewExtensions(),
        WORKSPACE_EDITOR_STYLE,
        LSP_EDITOR_STYLE,
        WORKSPACE_SEARCH_STYLE,
        keymap.of([
          { key: "Mod-s", run: saveHandler },
          { key: "Mod-r", run: openReplacePanel },
          ...workspaceEditorKeymap,
          ...searchKeymap,
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void languageForPath(path)
      .then((language: Extension | null) => {
        if (cancelled || !viewRef.current) return;
        viewRef.current.dispatch({
          effects: languageCompartment.current.reconfigure(language ?? []),
        });
      })
      .catch(() => {
        if (cancelled || !viewRef.current) return;
        viewRef.current.dispatch({
          effects: languageCompartment.current.reconfigure([]),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: diagnosticsCompartment.current.reconfigure(lspDiagnosticsExtension(diagnostics)),
    });
  }, [diagnostics]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === doc) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: doc } });
  }, [doc]);

  useEffect(() => {
    if (!visible) return;
    viewRef.current?.requestMeasure();
  }, [visible]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !reveal) return;
    const pos = offsetFromLspPosition(view.state.doc, reveal);
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    view.focus();
  }, [reveal]);

  return <div ref={hostRef} className="h-full w-full" />;
}
