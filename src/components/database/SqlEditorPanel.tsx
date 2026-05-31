import { useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  sql,
  MySQL,
  PostgreSQL,
  StandardSQL,
  type SQLDialect,
} from "@codemirror/lang-sql";
import { autocompletion, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { bracketMatching, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";

interface SqlEditorPanelProps {
  engine: string;
  /** Initial document; the editor owns its content thereafter. */
  initialDoc?: string;
  /** Table/column names for schema-aware autocomplete. */
  schema?: Record<string, string[]>;
  onDocChange?: (doc: string) => void;
  /** Run callback receives selection if any text is selected, else full doc. */
  onRun?: (sql: string) => void;
  onFocus?: () => void;
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
  onDocChange,
  onRun,
  onFocus,
  handleRef,
}: SqlEditorPanelProps & { handleRef?: (h: SqlEditorHandle | null) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartment = useRef(new Compartment());
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
        history(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        langCompartment.current.of(
          sql({ dialect: dialectFor(engine), upperCaseKeywords: true }),
        ),
        keymap.of([
          { key: "F5", run: () => (runHandler(), true) },
          { key: "Mod-Enter", run: () => (runHandler(), true) },
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
          "&": { height: "100%", fontSize: "13px" },
          ".cm-scroller": { fontFamily: "var(--moba-mono-font, monospace)", overflow: "auto" },
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

  return <div ref={hostRef} className="h-full w-full overflow-hidden" data-testid="sql-editor" />;
}
