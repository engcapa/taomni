import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorState, Compartment, Prec } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
  type KeyBinding,
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
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  closeCompletion,
  moveCompletionSelection,
  startCompletion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { bracketMatching, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { DbMetadataCache } from "../../lib/dbMetadataCache";
import { codeMirrorSqlDialect } from "../../lib/sqlEditorDialect";
import { createSqlMetadataCompletionSource } from "../../lib/sqlMetadataCompletions";
import { createSqlStructuredCompletionSource } from "../../lib/sqlStructuredCompletions";
import {
  loadSqlCompletionPreferences,
  subscribeSqlCompletionPreferences,
  type SqlCompletionPreferences,
} from "../../lib/sqlCompletionPreferences";
import {
  loadSqlExecutionPreferences,
  subscribeSqlExecutionPreferences,
  type SqlExecutionPreferences,
} from "../../lib/sqlExecutionPreferences";

const DOC_CHANGE_DEBOUNCE_MS = 200;

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
  /** Run the statement at the cursor position. */
  onRunCurrent?: (context: SqlEditorRunContext) => void;
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
  preferences: SqlCompletionPreferences = loadSqlCompletionPreferences(),
) {
  const config = {
    activateOnTyping: preferences.activateOnTyping,
    activateOnTypingDelay: 75,
    updateSyncTime: 80,
    maxRenderedOptions: 80,
    defaultKeymap: false,
  };
  if (sources && sources.length > 0) {
    return autocompletion({ ...config, override: [...sources] });
  }
  if (defaultSources && defaultSources.length > 0) {
    return autocompletion({ ...config, override: [...defaultSources] });
  }
  return autocompletion(config);
}

export function sqlCompletionKeymapFor(
  preferences: SqlCompletionPreferences,
): readonly KeyBinding[] {
  const bindings: KeyBinding[] = [
    { key: preferences.triggerShortcut, run: startCompletion },
    { key: "Escape", run: closeCompletion },
    { key: "ArrowDown", run: moveCompletionSelection(true) },
    { key: "ArrowUp", run: moveCompletionSelection(false) },
    { key: "PageDown", run: moveCompletionSelection(true, "page") },
    { key: "PageUp", run: moveCompletionSelection(false, "page") },
  ];
  if (preferences.acceptWithEnter) bindings.push({ key: "Enter", run: acceptCompletion });
  if (preferences.acceptWithTab) bindings.push({ key: "Tab", run: acceptCompletion });
  return bindings;
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
function buildExecutionKeymap(
  preferences: SqlExecutionPreferences,
  runHandler: () => void,
  runCurrentHandler: () => void,
): readonly KeyBinding[] {
  // runHandler handles both Run All and Run Selection depending on selection state
  // When selection exists, existing runHandler already returns selection.
  // We map both runAll and runSelection to the same handler for backward compat;
  // the parent can still distinguish via context but for editor keymap it's unified.
  const bindings: KeyBinding[] = [
    { key: preferences.runAll, run: () => (runHandler(), true) },
    { key: preferences.runCurrent, run: () => (runCurrentHandler(), true) },
  ];
  // Avoid duplicate key if runSelection equals runAll/runCurrent (after dedup, we keep one)
  if (
    preferences.runSelection !== preferences.runAll &&
    preferences.runSelection !== preferences.runCurrent
  ) {
    bindings.push({ key: preferences.runSelection, run: () => (runHandler(), true) });
  }
  return bindings;
}

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
  onRunCurrent,
  onFocus,
  handleRef,
}: SqlEditorPanelProps & { handleRef?: (h: SqlEditorHandle | null) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartment = useRef(new Compartment());
  const autocompleteCompartment = useRef(new Compartment());
  const completionKeymapCompartment = useRef(new Compartment());
  const executionKeymapCompartment = useRef(new Compartment());
  const onRunRef = useRef(onRun);
  const onRunCurrentRef = useRef(onRunCurrent);
  const onDocChangeRef = useRef(onDocChange);
  const onFocusRef = useRef(onFocus);
  onRunRef.current = onRun;
  onRunCurrentRef.current = onRunCurrent;
  onDocChangeRef.current = onDocChange;
  onFocusRef.current = onFocus;
  const [metadataPending, setMetadataPending] = useState(0);
  const [metadataLoadingVisible, setMetadataLoadingVisible] = useState(false);
  const [metadataHint, setMetadataHint] = useState<string | null>(null);
  const [completionPreferences, setCompletionPreferences] = useState(loadSqlCompletionPreferences);
  const [executionPreferences, setExecutionPreferences] = useState(loadSqlExecutionPreferences);
  useEffect(
    () => subscribeSqlCompletionPreferences(setCompletionPreferences),
    [],
  );
  useEffect(
    () => subscribeSqlExecutionPreferences(setExecutionPreferences),
    [],
  );
  const onMetadataLoadingChange = useCallback((loading: boolean) => {
    if (loading) setMetadataHint(null);
    setMetadataPending((current) => Math.max(0, current + (loading ? 1 : -1)));
  }, []);
  const onMetadataError = useCallback((message: string) => {
    const status = `Metadata autocomplete failed: ${message}`;
    setMetadataHint(status);
    onMetadataStatus?.(status);
  }, [onMetadataStatus]);
  const onMetadataResult = useCallback((result: { count: number; limitReached: boolean }) => {
    setMetadataHint(
      result.limitReached
        ? `Showing the first ${result.count} metadata matches. Keep typing to narrow the list.`
        : null,
    );
  }, []);
  useEffect(() => {
    if (metadataPending === 0) {
      setMetadataLoadingVisible(false);
      return;
    }
    const timer = setTimeout(() => setMetadataLoadingVisible(true), 120);
    return () => clearTimeout(timer);
  }, [metadataPending]);
  useEffect(() => {
    if (!metadataHint) return;
    const timer = setTimeout(() => setMetadataHint(null), 4_000);
    return () => clearTimeout(timer);
  }, [metadataHint]);
  const metadataCompletionSource = useMemo(
    () =>
      metadataCache
        ? createSqlMetadataCompletionSource({
            cache: metadataCache,
            engine,
            activeSchema,
            catalog,
            onError: onMetadataError,
            onLoadingChange: onMetadataLoadingChange,
            onResult: onMetadataResult,
          })
        : null,
    [
      activeSchema,
      catalog,
      engine,
      metadataCache,
      onMetadataError,
      onMetadataLoadingChange,
      onMetadataResult,
    ],
  );
  const structuredCompletionSource = useMemo(
    () => createSqlStructuredCompletionSource({ engine }),
    [engine],
  );
  const defaultSources = useMemo(
    () =>
      defaultCompletionSources(
        engine,
        schema,
        metadataCompletionSource
          ? [structuredCompletionSource, metadataCompletionSource]
          : [structuredCompletionSource],
      ),
    [engine, metadataCompletionSource, schema, structuredCompletionSource],
  );

  // Build editor once on mount.
  useEffect(() => {
    if (!hostRef.current) return;
    let pendingDoc: EditorState["doc"] | null = null;
    let docChangeTimer: ReturnType<typeof setTimeout> | null = null;
    const flushPendingDocChange = () => {
      if (docChangeTimer !== null) {
        clearTimeout(docChangeTimer);
        docChangeTimer = null;
      }
      if (!pendingDoc) return;
      const doc = pendingDoc;
      pendingDoc = null;
      onDocChangeRef.current?.(doc.toString());
    };
    const scheduleDocChange = (doc: EditorState["doc"]) => {
      pendingDoc = doc;
      if (docChangeTimer !== null) clearTimeout(docChangeTimer);
      docChangeTimer = setTimeout(flushPendingDocChange, DOC_CHANGE_DEBOUNCE_MS);
    };
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
    const runCurrentHandler = () => {
      const view = viewRef.current;
      if (!view) return;
      const sel = view.state.selection.main;
      onRunCurrentRef.current?.({
        doc: view.state.doc.toString(),
        cursorPosition: sel.head,
        selectionRange: sel.empty ? null : { from: sel.from, to: sel.to },
      });
    };

    const executionKeymap = buildExecutionKeymap(
      loadSqlExecutionPreferences(),
      runHandler,
      runCurrentHandler,
    );

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
        autocompleteCompartment.current.of(
          autocompleteFor(completionSources, defaultSources, completionPreferences),
        ),
        completionKeymapCompartment.current.of(
          Prec.highest(keymap.of(sqlCompletionKeymapFor(completionPreferences))),
        ),
        executionKeymapCompartment.current.of(
          Prec.high(keymap.of(executionKeymap)),
        ),
        syntaxHighlighting(sqlHighlightStyle),
        langCompartment.current.of(
          sql({ dialect: codeMirrorSqlDialect(engine), upperCaseKeywords: true }),
        ),
        keymap.of([
          { key: "Shift-Alt-ArrowUp", run: addCursorAbove },
          { key: "Shift-Alt-ArrowDown", run: addCursorBelow },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) scheduleDocChange(u.state.doc);
        }),
        EditorView.domEventHandlers({
          focus: () => {
            onFocusRef.current?.();
            return false;
          },
          blur: () => {
            flushPendingDocChange();
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
      flushPendingDocChange();
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
        autocompleteFor(completionSources, defaultSources, completionPreferences),
      ),
    });
  }, [completionPreferences, completionSources, defaultSources]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: completionKeymapCompartment.current.reconfigure(
        Prec.highest(keymap.of(sqlCompletionKeymapFor(completionPreferences))),
      ),
    });
  }, [completionPreferences]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const runHandler = () => {
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
    const runCurrentHandler = () => {
      const sel = view.state.selection.main;
      onRunCurrentRef.current?.({
        doc: view.state.doc.toString(),
        cursorPosition: sel.head,
        selectionRange: sel.empty ? null : { from: sel.from, to: sel.to },
      });
    };
    view.dispatch({
      effects: executionKeymapCompartment.current.reconfigure(
        Prec.high(keymap.of(buildExecutionKeymap(executionPreferences, runHandler, runCurrentHandler))),
      ),
    });
  }, [executionPreferences]);

  return (
    <div className="h-full w-full overflow-hidden relative" data-testid="sql-editor">
      <div ref={hostRef} className="h-full w-full overflow-hidden" />
      {(metadataLoadingVisible || metadataHint) && (
        <div
          className="absolute right-2 bottom-2 max-w-[min(420px,calc(100%-1rem))] rounded px-2 py-1 text-[11px] pointer-events-none"
          style={{
            color: metadataHint ? "var(--taomni-warning, #b45309)" : "var(--taomni-text-muted)",
            background: "var(--taomni-panel-bg)",
            border: "1px solid var(--taomni-divider)",
            boxShadow: "var(--taomni-shadow-sm)",
          }}
          data-testid="sql-completion-status"
          aria-live="polite"
        >
          {metadataHint ?? "Loading metadata completions…"}
        </div>
      )}
    </div>
  );
}
