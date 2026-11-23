import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { createBookmarksAndHistoryExtension } from "./bookmarksAndHistory";
import { createColumnSelectionExtension } from "./columnSelection";
import { createMarksExtension } from "./marksAndTokens";
import { createOverwriteExtension, createVirtualSpaceExtension } from "./overwriteAndVirtualSpace";
import { createSymbolsExtension, type SymbolRenderConfig } from "./symbols";
import type { NotepadMarkRule } from "../../../stores/notepadStore";

export interface NotepadCompartments {
  readOnly: Compartment;
  editable: Compartment;
  wrap: Compartment;
  lineNumbers: Compartment;
  tabSize: Compartment;
  theme: Compartment;
}

export function createNotepadCompartments(): NotepadCompartments {
  return {
    readOnly: new Compartment(),
    editable: new Compartment(),
    wrap: new Compartment(),
    lineNumbers: new Compartment(),
    tabSize: new Compartment(),
    theme: new Compartment(),
  };
}

export function buildNotepadTheme(fontSizePx: number): Extension {
  return EditorView.theme({
    "&": {
      height: "100%",
      fontSize: `${fontSizePx}px`,
      backgroundColor: "transparent",
      color: "inherit",
    },
    ".cm-scroller": {
      fontFamily: "var(--taomni-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
      lineHeight: "1.5",
      overflow: "auto",
    },
    ".cm-content": {
      caretColor: "var(--taomni-accent, #3b82f6)",
      padding: "4px 0",
    },
    ".cm-gutters": {
      backgroundColor: "transparent",
      borderRight: "1px solid var(--taomni-divider)",
      color: "var(--taomni-text-muted)",
      userSelect: "none",
    },
    // The workbench does not enable CodeMirror's dark facet, so its baseTheme
    // light selection fills (#d7d4f0 focused / #d9d9d9 unfocused) would clash
    // with the app's dark notepad text token (#e6eaf0) and wash the selected
    // text out. Use the same app selection tokens as the Markdown source
    // editor (viewer.css `--editor-sel*`) so both editors look identical.
    "& > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: "var(--taomni-editor-selection-unfocused-bg, rgba(37, 99, 235, 0.14)) !important",
    },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "var(--taomni-editor-selection-bg, rgba(37, 99, 235, 0.26)) !important",
    },
    "::selection": {
      backgroundColor: "var(--taomni-editor-selection-bg, rgba(37, 99, 235, 0.26))",
    },
    // Same contract as the Markdown source editor for search-match decorators:
    // amber tokens stay distinguishable from the blue selection fill.
    ".cm-selectionMatch": {
      backgroundColor: "var(--taomni-editor-selection-match-bg, rgba(245, 158, 11, 0.24))",
      outline: "1px solid var(--taomni-editor-selection-match-border, rgba(245, 158, 11, 0.58))",
      borderRadius: "2px",
    },
    ".cm-selectionMatch.cm-selectionMatch-main": {
      backgroundColor: "transparent",
      outline: "none",
    },
    // Active line and active gutter fills paint above the drawSelection layer,
    // so while a range is selected they would tint the last selected line and
    // break the even fill. The plugin below toggles this class.
    "&.np-selection-active .cm-activeLine, &.np-selection-active .cm-activeLineGutter": {
      backgroundColor: "transparent !important",
    },
  });
}

function syncSelectionActiveClass(view: EditorView): void {
  view.dom.classList.toggle(
    "np-selection-active",
    view.state.selection.ranges.some((range) => !range.empty),
  );
}

/** Keep the active-line occluder suppressed only while a real range is selected. */
function createSelectionActiveExtension(): Extension {
  return ViewPlugin.fromClass(class {
    constructor(view: EditorView) {
      syncSelectionActiveClass(view);
    }
    update(update: ViewUpdate) {
      if (update.selectionSet || update.docChanged) syncSelectionActiveClass(update.view);
    }
  });
}

/**
 * Assemble DEC-16 compliant CM6 extensions (no syntax highlighting, no folding,
 * no autocomplete, no bracket matching, no comment toggle).
 */
export function buildNotepadExtensions(options: {
  compartments: NotepadCompartments;
  readOnly: boolean;
  wrap: boolean;
  showLineNumbers: boolean;
  fontSizePx: number;
  tabSize?: number;
  symbols: SymbolRenderConfig;
  bookmarks: number[];
  baselineLines: string[];
  showChangeHistory: boolean;
  marks: NotepadMarkRule[];
  onToggleBookmark?: (lineZeroBased: number) => void;
  onToggleInsertMode?: (insertMode: boolean) => void;
  onUpdate?: (view: EditorView) => void;
}): Extension[] {
  const { compartments } = options;
  const tabSize = options.tabSize ?? 4;

  return [
    EditorState.allowMultipleSelections.of(true),
    compartments.lineNumbers.of(options.showLineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []),
    highlightActiveLine(),
    drawSelection(),
    createSelectionActiveExtension(),
    history(),
    compartments.tabSize.of([EditorState.tabSize.of(tabSize), indentUnit.of(" ".repeat(tabSize))]),
    compartments.readOnly.of(EditorState.readOnly.of(options.readOnly)),
    compartments.editable.of(EditorView.editable.of(!options.readOnly)),
    compartments.wrap.of(options.wrap ? EditorView.lineWrapping : []),
    compartments.theme.of(buildNotepadTheme(options.fontSizePx)),
    createColumnSelectionExtension(),
    createOverwriteExtension(options.onToggleInsertMode),
    createVirtualSpaceExtension(false),
    createSymbolsExtension(options.symbols),
    createBookmarksAndHistoryExtension({
      initialBookmarks: options.bookmarks,
      initialBaseline: options.baselineLines,
      showChangeHistory: options.showChangeHistory,
      onToggleBookmark: options.onToggleBookmark,
    }),
    createMarksExtension({ rules: options.marks }),
    // The workbench used to rely on the browser's default contenteditable
    // editing for Enter/Backspace/arrows. WebKitGTK then duplicated line breaks
    // under fast WebDriver key streams. Bind the standard editing commands so
    // the editor owns them (the previous shared TextEditor did the same).
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.updateListener.of((update) => {
      options.onUpdate?.(update.view);
    }),
  ];
}
