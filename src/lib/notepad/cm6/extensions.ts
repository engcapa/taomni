import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
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
