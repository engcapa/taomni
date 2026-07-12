import { useEffect, useRef, type MutableRefObject } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  hoverTooltip,
  keymap,
  lineNumbers,
  rectangularSelection,
  showTooltip,
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
  LspCompletionItem,
  LspCompletionResult,
  LspDiagnostic,
  LspDocumentHighlight,
  LspInlayHint,
  LspSemanticToken,
  LspPosition,
  LspRange,
  LspSignatureHelpResult,
} from "../../../lib/editor/lsp";
import { languageForPath } from "../../git/diffLanguage";
import { createWorkspaceSearchPanel, WORKSPACE_SEARCH_STYLE } from "./editorSearchPanel";
import { createLspCompletionSource } from "./lspCompletion";
import { createDiagnosticChrome } from "./lspDiagnosticChrome";
import { createLspIntelligenceChrome } from "./lspIntelligenceChrome";
import { createGitEditorChrome, type GitLineChange } from "./gitEditorChrome";
import type { GitBlameLine } from "../../../lib/git";
import { lspPositionFromOffset, offsetFromLspPosition } from "./lspPositions";
import {
  expandSelectionFromLspRanges,
  expandSyntaxSelection,
  selectionHistoryField,
  workspaceEditorKeymap,
} from "./workspaceEditorCommands";

interface EditorRevealTarget {
  line: number;
  character: number;
}

export interface EditorSelectionRange {
  start: LspPosition;
  end: LspPosition;
  empty: boolean;
  text: string;
  /** Viewport-relative rect of the selection head; null when empty/unavailable. */
  rect: { top: number; left: number; right: number; bottom: number } | null;
}

interface CodeMirrorHostProps {
  path: string;
  doc: string;
  visible: boolean;
  diagnostics: LspDiagnostic[];
  highlights?: LspDocumentHighlight[];
  inlayHints?: LspInlayHint[];
  semanticTokens?: LspSemanticToken[];
  gitChanges?: GitLineChange[];
  gitBlame?: GitBlameLine | null;
  reveal: EditorRevealTarget | null;
  onChange: (doc: string) => void;
  onSave: () => void;
  onHover: (position: LspPosition) => Promise<string | null>;
  onDefinition: (position: LspPosition) => Promise<boolean>;
  onReferences: (position: LspPosition) => Promise<void>;
  onComplete?: (
    position: LspPosition,
    triggerCharacter: string | null,
  ) => Promise<LspCompletionResult | null>;
  onCompleteResolve?: (raw: unknown) => Promise<LspCompletionItem | null>;
  onSignatureHelp?: (
    position: LspPosition,
    triggerCharacter: string | null,
  ) => Promise<LspSignatureHelpResult | null>;
  onSelectionChange?: (selection: EditorSelectionRange) => void;
  onViewportChange?: (range: LspRange) => void;
  onExpandSelection?: (selection: EditorSelectionRange) => Promise<LspRange[] | null>;
  onLightbulb?: (line: number) => void;
  onGitChangeClick?: (change: GitLineChange) => void;
  completionTriggers?: string[];
  signatureTriggers?: string[];
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

function signatureTooltipDom(result: LspSignatureHelpResult): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-lsp-hover taomni-chat-md";
  const active = Math.min(result.activeSignature, Math.max(0, result.signatures.length - 1));
  const signature = result.signatures[active];
  const label = document.createElement("div");
  label.style.fontFamily = "var(--taomni-code-font-family, monospace)";
  label.style.whiteSpace = "pre-wrap";
  const parameterIndex = signature.activeParameter ?? result.activeParameter;
  const parameter = signature.parameters[parameterIndex];
  const start = parameter?.labelStart
    ?? (parameter ? signature.label.indexOf(parameter.label) : -1);
  const end = parameter?.labelEnd
    ?? (parameter && start >= 0 ? start + parameter.label.length : -1);
  if (parameter && start >= 0 && end > start) {
    label.append(signature.label.slice(0, start));
    const bold = document.createElement("b");
    bold.textContent = signature.label.slice(start, end);
    label.append(bold, signature.label.slice(end));
  } else {
    label.textContent = signature.label;
  }
  dom.appendChild(label);
  if (result.signatures.length > 1) {
    const counter = document.createElement("div");
    counter.style.opacity = "0.6";
    counter.style.fontSize = "11px";
    counter.textContent = `${active + 1}/${result.signatures.length} overloads`;
    dom.appendChild(counter);
  }
  const documentation = parameter?.documentation ?? signature.documentation;
  if (documentation) {
    const doc = document.createElement("div");
    doc.style.marginTop = "6px";
    doc.innerHTML = renderFormatted(documentation, "md") ?? "";
    dom.appendChild(doc);
  }
  return dom;
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
  highlights = [],
  inlayHints = [],
  semanticTokens = [],
  gitChanges = [],
  gitBlame = null,
  reveal,
  onChange,
  onSave,
  onHover,
  onDefinition,
  onReferences,
  onComplete,
  onCompleteResolve,
  onSignatureHelp,
  onSelectionChange,
  onViewportChange,
  onExpandSelection,
  onLightbulb,
  onGitChangeClick,
  completionTriggers,
  signatureTriggers,
}: CodeMirrorHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartment = useRef(new Compartment());
  const diagnosticsCompartment = useRef(new Compartment());
  const intelligenceCompartment = useRef(new Compartment());
  const gitCompartment = useRef(new Compartment());
  const signatureCompartment = useRef(new Compartment());
  const signatureShownRef = useRef(false);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onHoverRef = useRef(onHover);
  const onDefinitionRef = useRef(onDefinition);
  const onReferencesRef = useRef(onReferences);
  const onCompleteRef = useRef(onComplete);
  const onCompleteResolveRef = useRef(onCompleteResolve);
  const onSignatureHelpRef = useRef(onSignatureHelp);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onViewportChangeRef = useRef(onViewportChange);
  const onExpandSelectionRef = useRef(onExpandSelection);
  const onLightbulbRef = useRef(onLightbulb);
  const onGitChangeClickRef = useRef(onGitChangeClick);
  const completionTriggersRef = useRef(completionTriggers ?? []);
  const signatureTriggersRef = useRef(signatureTriggers ?? []);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onHoverRef.current = onHover;
  onDefinitionRef.current = onDefinition;
  onReferencesRef.current = onReferences;
  onCompleteRef.current = onComplete;
  onCompleteResolveRef.current = onCompleteResolve;
  onSignatureHelpRef.current = onSignatureHelp;
  onSelectionChangeRef.current = onSelectionChange;
  onViewportChangeRef.current = onViewportChange;
  onExpandSelectionRef.current = onExpandSelection;
  onLightbulbRef.current = onLightbulb;
  onGitChangeClickRef.current = onGitChangeClick;
  completionTriggersRef.current = completionTriggers ?? [];
  signatureTriggersRef.current = signatureTriggers ?? [];

  const emitSelection = (view: EditorView) => {
    const handler = onSelectionChangeRef.current;
    if (!handler) return;
    const main = view.state.selection.main;
    const from = Math.min(main.from, main.to);
    const to = Math.max(main.from, main.to);
    let rect: EditorSelectionRange["rect"] = null;
    if (!main.empty) {
      const startCoords = view.coordsAtPos(from);
      const endCoords = view.coordsAtPos(to);
      if (startCoords && endCoords) {
        rect = {
          top: Math.min(startCoords.top, endCoords.top),
          left: Math.min(startCoords.left, endCoords.left),
          right: Math.max(startCoords.right, endCoords.right),
          bottom: Math.max(startCoords.bottom, endCoords.bottom),
        };
      }
    }
    handler({
      start: lspPositionFromOffset(view.state.doc, from),
      end: lspPositionFromOffset(view.state.doc, to),
      empty: main.empty,
      text: main.empty ? "" : view.state.doc.sliceString(from, to),
      rect,
    });
  };

  const emitViewport = (view: EditorView) => {
    onViewportChangeRef.current?.({
      start: lspPositionFromOffset(view.state.doc, view.viewport.from),
      end: lspPositionFromOffset(view.state.doc, view.viewport.to),
    });
  };

  useEffect(() => {
    if (!hostRef.current) return;
    const saveHandler = () => {
      onSaveRef.current();
      return true;
    };
    const hideSignature = () => {
      if (!signatureShownRef.current) return false;
      signatureShownRef.current = false;
      // Deferred: this may run from inside an update listener, where
      // synchronous dispatches are not allowed.
      window.queueMicrotask(() => {
        viewRef.current?.dispatch({
          effects: signatureCompartment.current.reconfigure([]),
        });
      });
      return true;
    };
    const requestSignatureHelp = (view: EditorView, trigger: string | null) => {
      const handler = onSignatureHelpRef.current;
      if (!handler) return false;
      const position = lspPositionFromOffset(view.state.doc, view.state.selection.main.head);
      void handler(position, trigger)
        .then((result) => {
          const current = viewRef.current;
          if (!current) return;
          if (!result || result.signatures.length === 0) {
            hideSignature();
            return;
          }
          signatureShownRef.current = true;
          const pos = current.state.selection.main.head;
          current.dispatch({
            effects: signatureCompartment.current.reconfigure(
              showTooltip.of({
                pos,
                above: true,
                create: () => ({ dom: signatureTooltipDom(result) }),
              }),
            ),
          });
        })
        .catch(() => {});
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
    const expandSemanticSelection = (view: EditorView) => {
      const handler = onExpandSelectionRef.current;
      if (!handler) return expandSyntaxSelection(view);
      const main = view.state.selection.main;
      const selection: EditorSelectionRange = {
        start: lspPositionFromOffset(view.state.doc, main.from),
        end: lspPositionFromOffset(view.state.doc, main.to),
        empty: main.empty,
        text: main.empty ? "" : view.state.doc.sliceString(main.from, main.to),
        rect: null,
      };
      void handler(selection).then((ranges) => {
        const current = viewRef.current;
        if (!current || current !== view) return;
        if (!ranges || !expandSelectionFromLspRanges(current, ranges)) {
          expandSyntaxSelection(current);
        }
      }).catch(() => {
        const current = viewRef.current;
        if (current === view) expandSyntaxSelection(current);
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
        autocompletion({
          override: [
            createLspCompletionSource({
              fetch: (position, trigger) =>
                onCompleteRef.current?.(position, trigger) ?? Promise.resolve(null),
              resolve: (raw) =>
                onCompleteResolveRef.current?.(raw) ?? Promise.resolve(null),
              triggerCharacters: () => completionTriggersRef.current,
            }),
          ],
        }),
        search({ top: true, createPanel: createWorkspaceSearchPanel }),
        selectionHistoryField,
        languageCompartment.current.of([]),
        diagnosticsCompartment.current.of(createDiagnosticChrome(
          diagnostics,
          (line) => onLightbulbRef.current?.(line),
        )),
        intelligenceCompartment.current.of(createLspIntelligenceChrome(
          EditorState.create({ doc }).doc,
          highlights,
          inlayHints,
        )),
        gitCompartment.current.of(createGitEditorChrome(
          gitChanges,
          gitBlame,
          (change) => onGitChangeClickRef.current?.(change),
        )),
        signatureCompartment.current.of([]),
        ...lspInteractionExtensions(onHoverRef, onDefinitionRef, onReferencesRef),
        ...codeViewExtensions(),
        WORKSPACE_EDITOR_STYLE,
        LSP_EDITOR_STYLE,
        WORKSPACE_SEARCH_STYLE,
        keymap.of([
          { key: "Mod-s", run: saveHandler },
          { key: "Mod-r", run: openReplacePanel },
          { key: "Escape", run: () => hideSignature() },
          { key: "Mod-Shift-Space", run: (view) => requestSignatureHelp(view, null) },
          { key: "Mod-w", run: expandSemanticSelection },
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
            let inserted = "";
            update.changes.iterChanges((_fromA, _toA, _fromB, _toB, text) => {
              inserted = text.toString();
            });
            const lastChar = inserted.slice(-1);
            if (lastChar && signatureTriggersRef.current.includes(lastChar)) {
              requestSignatureHelp(update.view, lastChar);
            } else if (
              signatureShownRef.current &&
              (lastChar === ")" || inserted.includes("\n"))
            ) {
              hideSignature();
            }
          } else if (update.selectionSet && signatureShownRef.current) {
            // A cursor move without an edit (mouse click, jump) dismisses it.
            hideSignature();
          }
          if (update.selectionSet || update.docChanged) {
            emitSelection(update.view);
          }
          if (update.viewportChanged || update.docChanged) emitViewport(update.view);
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    emitSelection(view);
    emitViewport(view);
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
      effects: diagnosticsCompartment.current.reconfigure(createDiagnosticChrome(
        diagnostics,
        (line) => onLightbulbRef.current?.(line),
      )),
    });
  }, [diagnostics]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: intelligenceCompartment.current.reconfigure(
        createLspIntelligenceChrome(view.state.doc, highlights, inlayHints, semanticTokens),
      ),
    });
  }, [highlights, inlayHints, semanticTokens]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: gitCompartment.current.reconfigure(createGitEditorChrome(
        gitChanges,
        gitBlame,
        (change) => onGitChangeClickRef.current?.(change),
      )),
    });
  }, [gitBlame, gitChanges]);

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
