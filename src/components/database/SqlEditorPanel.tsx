import { useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
} from "@codemirror/view";
import {
  addCursorAbove,
  addCursorBelow,
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  sql,
  MySQL,
  PostgreSQL,
  StandardSQL,
  type SQLDialect,
} from "@codemirror/lang-sql";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { bracketMatching, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";

interface SqlEditorPanelProps {
  engine: string;
  /** Initial document; the editor owns its content thereafter. */
  initialDoc?: string;
  /** Table/column names for schema-aware autocomplete. */
  schema?: Record<string, string[]>;
  /**
   * When provided, these sources fully replace the language's built-in
   * keyword/schema completion. Used by the HBase shell editor to suggest HBase
   * shell commands instead of SQL keywords.
   */
  completionSources?: readonly CompletionSource[];
  onDocChange?: (doc: string) => void;
  /** Run callback receives selection if any text is selected, else full doc. */
  onRun?: (sql: string) => void;
  onFocus?: () => void;
}

/**
 * Build the autocompletion extension. When `completionSources` are given they
 * override the language-data sources (so lang-sql's SQL keyword completion is
 * suppressed); otherwise the default language-driven completion is used.
 */
function autocompleteFor(sources?: readonly CompletionSource[]) {
  return sources && sources.length > 0
    ? autocompletion({ override: [...sources] })
    : autocompletion();
}

function dialectFor(engine: string): SQLDialect {
  switch (engine) {
    case "MySQL":
      return MySQL;
    case "PostgreSQL":
      return PostgreSQL;
    default:
      return StandardSQL;
  }
}

export interface SqlEditorHandle {
  getValue: () => string;
  getSelectionOrAll: () => string;
  setValue: (text: string) => void;
  insertText: (text: string) => void;
  focus: () => void;
}

/**
 * A CodeMirror 6 SQL editor. The imperative handle is exposed through the
 * `handleRef` callback so the parent toolbar (Run / Run selection / Format)
 * can drive it without re-rendering the view.
 */
export function SqlEditorPanel({
  engine,
  initialDoc = "",
  schema,
  completionSources,
  onDocChange,
  onRun,
  onFocus,
  handleRef,
}: SqlEditorPanelProps & { handleRef?: (h: SqlEditorHandle | null) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartment = useRef(new Compartment());
  const autocompleteCompartment = useRef(new Compartment());
  const onRunRef = useRef(onRun);
  const onDocChangeRef = useRef(onDocChange);
  const onFocusRef = useRef(onFocus);
  onRunRef.current = onRun;
  onDocChangeRef.current = onDocChange;
  onFocusRef.current = onFocus;

  // Build editor once on mount.
  useEffect(() => {
    if (!hostRef.current) return;
    const runHandler = () => {
      const view = viewRef.current;
      if (!view) return;
      const sel = view.state.selection.main;
      const text = sel.empty
        ? view.state.doc.toString()
        : view.state.sliceDoc(sel.from, sel.to);
      onRunRef.current?.(text);
    };

    const state = EditorState.create({
      doc: initialDoc,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        EditorState.allowMultipleSelections.of(true),
        // drawSelection renders the multi-range / rectangular selection layer;
        // without it CodeMirror falls back to the native browser selection,
        // which can only show a single contiguous range, so block selection
        // and multi-cursors never become visible.
        drawSelection(),
        rectangularSelection({
          eventFilter: (event) =>
            event.button === 0 && (event.altKey || (event.ctrlKey && event.shiftKey)),
        }),
        crosshairCursor(),
        history(),
        bracketMatching(),
        closeBrackets(),
        autocompleteCompartment.current.of(autocompleteFor(completionSources)),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        langCompartment.current.of(
          sql({ dialect: dialectFor(engine), upperCaseKeywords: true }),
        ),
        keymap.of([
          { key: "F5", run: () => (runHandler(), true) },
          { key: "Mod-Enter", run: () => (runHandler(), true) },
          { key: "Shift-Alt-ArrowUp", run: addCursorAbove },
          { key: "Shift-Alt-ArrowDown", run: addCursorBelow },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onDocChangeRef.current?.(u.state.doc.toString());
        }),
        EditorView.domEventHandlers({
          focus: () => {
            onFocusRef.current?.();
            return false;
          },
        }),
        EditorView.theme({
          "&": {
            height: "100%",
            fontSize: "var(--taomni-db-font-size, 13px)",
            backgroundColor: "var(--taomni-bg)",
            color: "var(--taomni-text)",
          },
          ".cm-content": {
            // No backgroundColor here: the root "&" already paints --taomni-bg.
            // drawSelection() renders the selection as a z-index:-1 layer *below*
            // .cm-content, so an opaque content background would hide it.
            color: "var(--taomni-text)",
          },
          ".cm-gutters": {
            backgroundColor: "var(--taomni-bg)",
            color: "var(--taomni-text-muted)",
            borderRight: "1px solid var(--taomni-divider)",
          },
          ".cm-activeLineGutter": {
            backgroundColor: "var(--taomni-hover)",
            color: "var(--taomni-text)",
          },
          ".cm-activeLine": {
            // Translucent so the drawSelection() layer (rendered beneath the
            // content) stays visible when the cursor's line is selected.
            backgroundColor:
              "color-mix(in srgb, var(--taomni-hover) 55%, transparent)",
          },
          ".cm-scroller": { fontFamily: "var(--taomni-mono-font, monospace)", overflow: "auto" },
          ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
            backgroundColor: "var(--taomni-editor-selection-bg) !important",
          },
          ".cm-content ::selection": {
            backgroundColor: "var(--taomni-editor-selection-bg)",
            color: "var(--taomni-editor-selection-text)",
          },
          ".cm-selectionMatch": {
            backgroundColor: "var(--taomni-editor-selection-match-bg)",
            outline: "1px solid var(--taomni-editor-selection-match-border)",
          },
          ".cm-cursor": {
            borderLeftColor: "var(--taomni-accent)",
          },
          "&.cm-focused": { outline: "none" },
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;

    const handle: SqlEditorHandle = {
      getValue: () => view.state.doc.toString(),
      getSelectionOrAll: () => {
        const sel = view.state.selection.main;
        return sel.empty ? view.state.doc.toString() : view.state.sliceDoc(sel.from, sel.to);
      },
      setValue: (text: string) => {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      },
      insertText: (text: string) => {
        const pos = view.state.selection.main.to;
        view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } });
        view.focus();
      },
      focus: () => view.focus(),
    };
    handleRef?.(handle);

    return () => {
      handleRef?.(null);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconfigure dialect (+ schema completion) when engine/schema changes.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: langCompartment.current.reconfigure(
        sql({
          dialect: dialectFor(engine),
          upperCaseKeywords: true,
          schema: schema && Object.keys(schema).length > 0 ? schema : undefined,
        }),
      ),
    });
  }, [engine, schema]);

  // Reconfigure completion sources when an override is supplied or changes
  // (e.g. HBase command/table suggestions as the object tree loads).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: autocompleteCompartment.current.reconfigure(autocompleteFor(completionSources)),
    });
  }, [completionSources]);

  return <div ref={hostRef} className="h-full w-full overflow-hidden" data-testid="sql-editor" />;
}
