import { type WorkspaceActionMetadata } from "../types";

export const viewActionMetadata: Record<string, WorkspaceActionMetadata> = {
  "workspace.activateToolWindow":

  // --- View ---
  {
    id: "workspace.activateToolWindow",
    title: "Activate Tool Window",
    description: "Activate, focus, or collapse a workspace tool window",
    category: "View",
    provenance: "local",
    keywords: ["tool window", "panel", "problems", "run", "project", "terminal"],
  },
  "workspace.returnToEditor":
  {
    id: "workspace.returnToEditor",
    title: "Focus Active Editor",
    description: "Return focus from tool windows or UI chrome to the active editor",
    category: "View",
    keybinding: "Escape",
    provenance: "local",
    keywords: ["editor", "focus", "escape", "return"],
  },
  "workspace.restoreToolWindowLayout":
  {
    id: "workspace.restoreToolWindowLayout",
    title: "Restore Default Tool Window Layout",
    description: "Restore Project and bottom tool windows to default layout (Project open, bottom dock closed) while preserving open files, editor groups, dirty state, and tool data",
    category: "View",
    keybinding: "Shift+F12",
    provenance: "local",
    keywords: ["restore", "layout", "default", "tool window", "reset", "shift+f12"],
  },
  "workspace.showProblems":
  {
    id: "workspace.showProblems",
    title: "Show Problems Tool Window",
    description: "Open and focus the Problems inspection dock",
    category: "View",
    keybinding: "Alt+6",
    provenance: "local",
    keywords: ["problems", "errors", "warnings", "inspect"],
  },
  "workspace.toggleProjectTree":
  {
    id: "workspace.toggleProjectTree",
    title: "Toggle Project Tree",
    description: "Show or hide the project explorer file tree",
    category: "View",
    keybinding: "Alt+1",
    platformKeybindings: { mac: ["Meta+1", "Alt+1"] },
    provenance: "local",
    keywords: ["tree", "explorer", "sidebar", "project"],
  },
  "workspace.toggleDocumentationPane":
  {
    id: "workspace.toggleDocumentationPane",
    title: "Toggle Documentation Tool Window",
    description: "Show or hide the right-side Documentation pane",
    category: "View",
    provenance: "local",
    keywords: ["documentation", "doc", "pane", "sidebar"],
  },
  "workspace.toggleTodosPane":
  {
    id: "workspace.toggleTodosPane",
    title: "Toggle TODOs & Bookmarks Tool Window",
    description: "Show or hide the right-side TODOs and Bookmarks pane",
    category: "View",
    provenance: "local",
    keywords: ["todo", "bookmarks", "pane"],
  },
  "workspace.toggleBookmark":
  {
    id: "workspace.toggleBookmark",
    title: "Toggle Bookmark",
    description: "Toggle a bookmark at cursor line",
    category: "View",
    keybinding: "F11",
    provenance: "local",
    keywords: ["bookmark", "mark", "line"],
  },
  "workspace.toggleBookmarkWithMnemonic":
  {
    id: "workspace.toggleBookmarkWithMnemonic",
    title: "Toggle Bookmark with Mnemonic",
    description: "Toggle a mnemonic (0-9 or A-Z) bookmark at cursor line",
    category: "View",
    keybinding: "Ctrl+F11",
    provenance: "local",
    keywords: ["bookmark", "mnemonic", "mark", "digit"],
  },
  "workspace.showBookmarks":
  {
    id: "workspace.showBookmarks",
    title: "Show Bookmarks",
    description: "Open the bookmarks tool window",
    category: "View",
    keybinding: "Shift+F11",
    provenance: "local",
    keywords: ["bookmark", "list", "show"],
  },
  "workspace.compareWithClipboard":
  {
    id: "workspace.compareWithClipboard",
    title: "Compare with Clipboard",
    description: "Compare current file or selection with clipboard content",
    category: "View",
    provenance: "local",
    keywords: ["diff", "compare", "clipboard"],
  },
  "workspace.compareWithFile":
  {
    id: "workspace.compareWithFile",
    title: "Compare with File…",
    description: "Compare current file with another file in workspace",
    category: "View",
    provenance: "local",
    keywords: ["diff", "compare", "file"],
  },
  "workspace.toggleRenderedDocComments":
  {
    id: "workspace.toggleRenderedDocComments",
    title: "Toggle Rendered Documentation",
    description: "Toggle in-place rendered documentation comments in reader mode",
    category: "View",
    keybinding: "Ctrl+Alt+Q",
    provenance: "local",
    keywords: ["doc", "render", "documentation", "reader", "comment", "jsdoc", "javadoc"],
  },
  "workspace.toggleInlayHints":
  {
    id: "workspace.toggleInlayHints",
    title: "Toggle Inlay Hints",
    description: "Show or hide parameter names and type inlay hints",
    category: "View",
    provenance: "provider",
    keywords: ["inlay", "hints", "types", "parameters"],
  },
  "workspace.toggleInlineBlame":
  {
    id: "workspace.toggleInlineBlame",
    title: "Toggle Git Inline Blame",
    description: "Show or hide author and commit message on current line",
    category: "View",
    provenance: "local",
    keywords: ["git", "blame", "author", "commit"],
  },
  "workspace.toggleSoftWrap":
  {
    id: "workspace.toggleSoftWrap",
    title: "Toggle Soft Wrap",
    description: "Wrap long code lines visually to fit editor window",
    category: "View",
    provenance: "local",
    keywords: ["wrap", "soft wrap", "lines"],
  },
  "workspace.toggleColumnSelection":
  {
    id: "workspace.toggleColumnSelection",
    title: "Toggle Column Selection Mode",
    description: "Enable rectangular / column-based multi-cursor selection",
    category: "View",
    keybinding: "Alt+Shift+Insert",
    provenance: "local",
    keywords: ["column", "rectangular", "selection", "block"],
  },
  "workspace.toggleSyncSplitScroll":
  {
    id: "workspace.toggleSyncSplitScroll",
    title: "Toggle Synchronized Split Scrolling",
    description: "Synchronize viewport scroll between left and right editor panes",
    category: "View",
    provenance: "local",
    keywords: ["scroll", "split", "sync", "mirror"],
  },
  "workspace.toggleTerminal":

  // --- Terminal ---
  {
    id: "workspace.toggleTerminal",
    title: "Toggle Integrated Terminal",
    description: "Open or hide the embedded terminal dock panel",
    category: "View",
    keybinding: "Alt+F12",
    provenance: "local",
    keywords: ["terminal", "shell", "pty", "bash"],
  },
  "workspace.openKeymapCheatsheet":

  // --- Help ---
  {
    id: "workspace.openKeymapCheatsheet",
    title: "Keyboard Shortcuts (Keymap)",
    description: "Open shortcut reference and command executor dialog",
    category: "Help",
    keybinding: "Ctrl+Alt+/",
    secondaryKeybindings: ["Meta+Alt+/", "Ctrl+K Ctrl+S", "Meta+K Meta+S"],
    provenance: "local",
    keywords: ["keymap", "shortcuts", "cheat sheet", "keyboard", "intellij"],
  }
};
