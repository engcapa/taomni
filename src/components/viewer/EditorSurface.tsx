import { useEffect, useLayoutEffect, useRef } from "react";
import { Compartment, EditorState, Transaction, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { useDocumentStore } from "../../stores/documentStore";
import { useFileOpenPreferences } from "../../lib/openFile/preferences";
import type { ViewerDocument } from "../../lib/viewer";

export interface EditorSurfaceProps {
  document: ViewerDocument;
  extensions?: Extension[];
  onView?: (view: EditorView | null) => void;
  onCursorChange?: (cursor: { line: number; column: number }) => void;
  className?: string;
}
const EMPTY_EXTENSIONS: Extension[] = [];
const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "var(--fv-font-size, 13px)", backgroundColor: "var(--bg)", color: "var(--text)" },
  ".cm-content": { fontFamily: "var(--taomni-code-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)", padding: "8px 0", minHeight: "100%", caretColor: "var(--accent-s)" },
  ".cm-scroller": { overflow: "auto", lineHeight: "1.65" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--muted)", border: "none", minWidth: "52px" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 14px 0 8px" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--taomni-hover)" },
  ".cm-cursor": { borderLeftColor: "var(--accent-s)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--sel)" },
  ".cm-panels": { backgroundColor: "var(--card)", color: "var(--text)", fontSize: "12px" },
  ".cm-search": { padding: "6px 10px" },
  ".cm-textfield": { backgroundColor: "var(--card)", border: "1px solid var(--input-b)", borderRadius: "5px", padding: "3px 6px" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--panel)", color: "var(--text)", borderColor: "var(--input-b)", borderRadius: "5px" },
});

async function language(path: string): Promise<Extension> {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "json" || extension === "jsonc") return (await import("@codemirror/lang-json")).json();
  if (extension === "yaml" || extension === "yml") return (await import("@codemirror/lang-yaml")).yaml();
  if (extension === "svg" || extension === "xml") return (await import("@codemirror/lang-xml")).xml({ autoCloseTags: false });
  if (extension === "html" || extension === "htm") return (await import("@codemirror/lang-html")).html();
  if (extension === "md" || extension === "markdown") return (await import("@codemirror/lang-markdown")).markdown();
  return [];
}

/** The view owns selection and history; shared store owns document text. Remote
 * store updates never recreate the editor or echo themselves back as user edits. */
export function EditorSurface({ document: current, extensions = EMPTY_EXTENSIONS, onView, onCursorChange, className = "" }: EditorSurfaceProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const currentRef = useRef(current);
  const onViewRef = useRef(onView);
  const onCursorRef = useRef(onCursorChange);
  const preferences = useFileOpenPreferences();
  const compartments = useRef({ editable: new Compartment(), wrap: new Compartment(), extra: new Compartment(), language: new Compartment() });
  const external = useRef(false);
  currentRef.current = current;
  onViewRef.current = onView;
  onCursorRef.current = onCursorChange;
  useLayoutEffect(() => {
    if (!host.current) return;
    const settings = useFileOpenPreferences.getState();
    const parts = compartments.current;
    const editor = new EditorView({ parent: host.current, state: EditorState.create({ doc: currentRef.current.content,
      extensions: [lineNumbers(), highlightActiveLineGutter(), drawSelection(), history(), indentOnInput(), bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }), highlightActiveLine(), search({ top: true }), highlightSelectionMatches(),
        keymap.of([{ key: "Mod-s", run: () => { void useDocumentStore.getState().save(currentRef.current.path).catch(() => {}); return true; } },
          ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        parts.editable.of([EditorState.readOnly.of(currentRef.current.readOnly), EditorView.editable.of(!currentRef.current.readOnly)]),
        parts.wrap.of(settings.wrap ? EditorView.lineWrapping : []), parts.extra.of(extensions), parts.language.of([]), theme,
        EditorView.contentAttributes.of({ "data-testid": "viewer-editor-content", "aria-label": "File content" }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !external.current) useDocumentStore.getState().edit(currentRef.current.path, update.state.doc.toString());
          if (update.docChanged || update.selectionSet) {
            const head = update.state.selection.main.head;
            const line = update.state.doc.lineAt(head);
            onCursorRef.current?.({ line: line.number, column: head - line.from + 1 });
          }
        }),
      ],
    }) });
    view.current = editor;
    onViewRef.current?.(editor);
    onCursorRef.current?.({ line: 1, column: 1 });
    let alive = true;
    void language(currentRef.current.path).then((extension) => { if (alive) editor.dispatch({ effects: parts.language.reconfigure(extension) }); }).catch(() => {});
    return () => { alive = false; onViewRef.current?.(null); view.current = null; editor.destroy(); };
    // Document identity is the lifecycle; text and options are reconfigured below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.key]);
  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === current.content) return;
    external.current = true;
    try { editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: current.content }, annotations: Transaction.addToHistory.of(false) }); }
    finally { external.current = false; }
  }, [current.content]);
  useEffect(() => {
    view.current?.dispatch({ effects: [
      compartments.current.editable.reconfigure([EditorState.readOnly.of(current.readOnly), EditorView.editable.of(!current.readOnly)]),
      compartments.current.wrap.reconfigure(preferences.wrap ? EditorView.lineWrapping : []),
      compartments.current.extra.reconfigure(extensions),
    ] });
  }, [current.readOnly, preferences.wrap, extensions]);
  return <div ref={host} data-testid="viewer-editor" className={`fv-editor ${className}`} style={{ "--fv-font-size": `${preferences.fontSize}px` } as React.CSSProperties} />;
}
