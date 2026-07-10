import { useEffect, useMemo, useRef } from "react";
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
  keywordCompletionSource,
  schemaCompletionSource,
  type SQLNamespace,
} from "@codemirror/lang-sql";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { bracketMatching, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { DbMetadataCache } from "../../lib/dbMetadataCache";
import { codeMirrorSqlDialect } from "../../lib/sqlEditorDialect";
import { createSqlMetadataCompletionSource } from "../../lib/sqlMetadataCompletions";

interface SqlEditorPanelProps {
  engine: string;
  /** Initial document; the editor owns its content thereafter. */
  initialDoc?: string;
  /** Table/column names for schema-aware autocomplete. */
  schema?: SQLNamespace;
  /** Shared database metadata cache for async dot completions. */
  metadataCache?: DbMetadataCache | null;
  /** Current default schema/database for resolving `table.` and aliases. */
  activeSchema?: string | null;
  /** Current/default Presto catalog for resolving catalog-qualified names. */
  catalog?: string | null;
  /** Surface non-blocking metadata completion failures. */
  onMetadataStatus?: (message: string) => void;
  /**
   * When provided, these sources fully replace the language's built-in
   * keyword/schema completion. Used by the HBase shell editor to suggest HBase
   * shell commands instead of SQL keywords.
   */
  completionSources?: readonly CompletionSource[];
  onDocChange?: (doc: string) => void;
  /** Run callback receives selection if any text is selected, else full doc. */
  onRun?: (sql: string, context: SqlEditorRunContext) => void;
  onFocus?: () => void;
}

/**
 * Build the autocompletion extension. When `completionSources` are given they
 * override the language-data sources (so lang-sql's SQL keyword completion is
 * suppressed); otherwise the default language-driven completion is used.
 */
function autocompleteFor(
  sources?: readonly CompletionSource[],
  defaultSources?: readonly CompletionSource[],
) {
  if (sources && sources.length > 0) return autocompletion({ override: [...sources] });
  if (defaultSources && defaultSources.length > 0) {
    return autocompletion({ override: [...defaultSources] });
  }
  return autocompletion();
}

const sqlHighlightStyle = HighlightStyle.define([
  {
    tag: tags.keyword,
    color: "var(--taomni-db-syntax-keyword, #1d4ed8)",
    fontWeight: "600",
  },
  {
    tag: [tags.definitionKeyword, tags.modifier, tags.operatorKeyword],
    color: "var(--taomni-db-syntax-keyword, #1d4ed8)",
    fontWeight: "600",
  },
  {
    tag: [tags.name, tags.variableName, tags.propertyName],
    color: "var(--taomni-db-syntax-name, var(--taomni-text))",
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: "var(--taomni-db-syntax-function, #0f766e)",
  },
  {
    tag: [tags.string, tags.special(tags.string)],
    color: "var(--taomni-db-syntax-string, #047857)",
  },
  {
    tag: [tags.number, tags.integer, tags.float, tags.bool, tags.atom],
    color: "var(--taomni-db-syntax-atom, #b45309)",
  },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: "var(--taomni-db-syntax-comment, var(--taomni-text-muted))",
    fontStyle: "italic",
  },
  {
    tag: [tags.operator, tags.compareOperator, tags.logicOperator, tags.arithmeticOperator],
    color: "var(--taomni-db-syntax-operator, var(--taomni-text-muted))",
  },
  {
    tag: [tags.punctuation, tags.separator],
    color: "var(--taomni-db-syntax-punctuation, var(--taomni-text-muted))",
  },
]);

function defaultCompletionSources(
  engine: string,
  schema?: SQLNamespace,
  extraSources: readonly CompletionSource[] = [],
): readonly CompletionSource[] {
  const dialect = codeMirrorSqlDialect(engine);
  const sources: CompletionSource[] = [
    keywordCompletionSource(dialect, true),
  ];
  if (schema) {
    sources.push(schemaCompletionSource({ dialect, schema, upperCaseKeywords: true }));
  }
  sources.push(...extraSources);
  return sources;
}

export interface SqlEditorHandle {
  getValue: () => string;
  getSelectionOrAll: () => string;
  getCursorPosition: () => number;
  getSelectionRange: () => { from: number; to: number } | null;
  setValue: (text: string) => void;
  selectRange: (from: number, to: number) => void;
  replaceRange: (from: number, to: number, text: string, options?: { focus?: boolean }) => void;
  insertText: (text: string) => void;
  focus: () => void;
}

export interface SqlEditorRunContext {
  doc: string;
  cursorPosition: number;
  selectionRange: { from: number; to: number } | null;
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
  metadataCache,
  activeSchema,
  catalog,
  onMetadataStatus,
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
  const metadataCompletionSource = useMemo(
    () =>
      metadataCache
        ? createSqlMetadataCompletionSource({
            cache: metadataCache,
            engine,
            activeSchema,
            catalog,
            onError: (message) => onMetadataStatus?.(`Metadata autocomplete failed: ${message}`),
          })
        : null,
    [activeSchema, catalog, engine, metadataCache, onMetadataStatus],
  );
  const defaultSources = useMemo(
    () =>
      defaultCompletionSources(
        engine,
        schema,
        metadataCompletionSource ? [metadataCompletionSource] : [],
      ),
    [engine, metadataCompletionSource, schema],
  );

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
      onRunRef.current?.(text, {
        doc: view.state.doc.toString(),
        cursorPosition: sel.head,
        selectionRange: sel.empty ? null : { from: sel.from, to: sel.to },
      });
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
        autocompleteCompartment.current.of(autocompleteFor(completionSources, defaultSources)),
        syntaxHighlighting(sqlHighlightStyle),
        langCompartment.current.of(
          sql({ dialect: codeMirrorSqlDialect(engine), upperCaseKeywords: true }),
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
          ".cm-tooltip, .cm-tooltip-autocomplete": {
            backgroundColor: "var(--taomni-panel-bg)",
            color: "var(--taomni-text)",
            border: "1px solid var(--taomni-divider)",
            boxShadow: "var(--taomni-shadow-md)",
          },
          ".cm-tooltip-autocomplete ul li[aria-selected]": {
            backgroundColor: "var(--taomni-selected)",
            color: "var(--taomni-text)",
          },
          ".cm-completionIcon": {
            color: "var(--taomni-text-muted)",
          },
          ".cm-completionMatchedText": {
            color: "var(--taomni-accent-soft)",
            textDecoration: "none",
            fontWeight: "600",
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
      getCursorPosition: () => view.state.selection.main.head,
      getSelectionRange: () => {
        const sel = view.state.selection.main;
        return sel.empty ? null : { from: sel.from, to: sel.to };
      },
      setValue: (text: string) => {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      },
      selectRange: (from: number, to: number) => {
        const start = Math.max(0, Math.min(from, view.state.doc.length));
        const end = Math.max(0, Math.min(to, view.state.doc.length));
        view.dispatch({ selection: { anchor: start, head: end }, scrollIntoView: true });
        view.focus();
      },
      replaceRange: (from: number, to: number, text: string, options) => {
        const start = Math.max(0, Math.min(from, view.state.doc.length));
        const end = Math.max(0, Math.min(to, view.state.doc.length));
        const rangeFrom = Math.min(start, end);
        view.dispatch({
          changes: { from: rangeFrom, to: Math.max(start, end), insert: text },
          selection: { anchor: rangeFrom + text.length },
          scrollIntoView: true,
        });
        if (options?.focus !== false) view.focus();
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
          dialect: codeMirrorSqlDialect(engine),
          upperCaseKeywords: true,
          schema: schema && Object.keys(schema).length > 0 ? schema : undefined,
        }),
      ),
    });
  }, [engine, schema]);

  // Reconfigure completion sources when an override or SQL metadata source changes.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: autocompleteCompartment.current.reconfigure(
        autocompleteFor(completionSources, defaultSources),
      ),
    });
  }, [completionSources, defaultSources]);

  return <div ref={hostRef} className="h-full w-full overflow-hidden" data-testid="sql-editor" />;
}
