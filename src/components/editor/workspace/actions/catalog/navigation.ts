import { type WorkspaceActionMetadata } from "../types";

export const navigationActionMetadata: Record<string, WorkspaceActionMetadata> = {
  "workspace.goToFile":

  // --- Navigate ---
  {
    id: "workspace.goToFile",
    title: "Go to File",
    description: "Find and open any file in the workspace",
    category: "Navigate",
    keybinding: "Ctrl+Shift+N",
    secondaryKeybindings: ["Meta+Shift+N"],
    provenance: "local",
    keywords: ["file", "open", "find", "search"],
  },
  "workspace.goToClass":
  {
    id: "workspace.goToClass",
    title: "Go to Class",
    description: "Find and jump to class, interface, enum, or struct definition",
    category: "Navigate",
    keybinding: "Ctrl+N",
    provenance: "provider",
    keywords: ["class", "type", "interface", "struct", "enum"],
  },
  "workspace.goToSymbol":
  {
    id: "workspace.goToSymbol",
    title: "Go to Symbol",
    description: "Search workspace symbols across all indexed files",
    category: "Navigate",
    keybinding: "Ctrl+Alt+Shift+N",
    provenance: "provider",
    keywords: ["symbol", "function", "method", "variable", "field"],
  },
  "workspace.searchEverywhere":
  {
    id: "workspace.searchEverywhere",
    title: "Search Everywhere",
    description: "Search all files, classes, symbols, and actions across the workspace",
    category: "Navigate",
    keybinding: "Shift+Shift",
    provenance: "local",
    keywords: ["search", "find", "everywhere", "symbol", "double shift"],
  },
  "workspace.recentFiles":
  {
    id: "workspace.recentFiles",
    title: "Recent Files",
    description: "List recently opened files and switch with rapid navigation",
    category: "Navigate",
    keybinding: "Ctrl+E",
    provenance: "local",
    keywords: ["recent", "switcher", "history", "files"],
  },
  "workspace.recentLocations":
  {
    id: "workspace.recentLocations",
    title: "Recent Locations",
    description: "Navigate to recently visited and edited code positions with context preview",
    category: "Navigate",
    keybinding: "Ctrl+Shift+E",
    provenance: "local",
    keywords: ["recent", "locations", "context", "history", "edit"],
  },
  "workspace.recentChangedFiles":
  {
    id: "workspace.recentChangedFiles",
    title: "Recently Changed Files",
    description: "Navigate to recently modified locations with context preview",
    category: "Navigate",
    keybinding: "Ctrl+Shift+E",
    provenance: "local",
    keywords: ["recent", "changed", "modified", "history"],
  },
  "workspace.lastEditLocation":
  {
    id: "workspace.lastEditLocation",
    title: "Last Edit Location",
    description: "Jump to the previous edit position in the editor",
    category: "Navigate",
    keybinding: "Ctrl+Shift+Backspace",
    provenance: "local",
    keywords: ["last", "edit", "location", "cursor", "back"],
  },
  "workspace.nextError":
  {
    id: "workspace.nextError",
    title: "Next Highlighted Error",
    description: "Navigate to the next error or warning in the active file",
    category: "Navigate",
    keybinding: "F2",
    provenance: "provider",
    keywords: ["error", "warning", "diagnostic", "next"],
  },
  "workspace.nextDiagnostic":
  {
    id: "workspace.nextDiagnostic",
    title: "Next Highlighted Error (Alias)",
    description: "Alias for workspace.nextError",
    category: "Navigate",
    keybinding: "F2",
    provenance: "provider",
    keywords: ["error", "warning", "diagnostic", "next"],
  },
  "workspace.prevError":
  {
    id: "workspace.prevError",
    title: "Previous Highlighted Error",
    description: "Navigate to the previous error or warning in the active file",
    category: "Navigate",
    keybinding: "Shift+F2",
    provenance: "provider",
    keywords: ["error", "warning", "diagnostic", "prev"],
  },
  "workspace.prevDiagnostic":
  {
    id: "workspace.prevDiagnostic",
    title: "Previous Highlighted Error (Alias)",
    description: "Alias for workspace.prevError",
    category: "Navigate",
    keybinding: "Shift+F2",
    provenance: "provider",
    keywords: ["error", "warning", "diagnostic", "prev"],
  },
  "workspace.quickDefinition":
  {
    id: "workspace.quickDefinition",
    title: "Quick Definition Peek",
    description: "Preview symbol definition inline without losing editor focus",
    category: "Navigate",
    keybinding: "Ctrl+Shift+I",
    provenance: "provider",
    keywords: ["definition", "peek", "preview", "quick"],
  },
  "workspace.quickDefinitionPeek":
  {
    id: "workspace.quickDefinitionPeek",
    title: "Quick Definition Peek (Alias)",
    description: "Alias for workspace.quickDefinition",
    category: "Navigate",
    keybinding: "Ctrl+Shift+I",
    provenance: "provider",
    keywords: ["definition", "peek", "preview"],
  },
  "workspace.quickDocumentation":
  {
    id: "workspace.quickDocumentation",
    title: "Quick Documentation",
    description: "Show documentation popup for symbol under cursor",
    category: "Navigate",
    keybinding: "Ctrl+Q",
    secondaryKeybindings: ["F1"],
    provenance: "provider",
    keywords: ["doc", "documentation", "hover", "help"],
  },
  "workspace.revealActiveFileInTree":
  {
    id: "workspace.revealActiveFileInTree",
    title: "Select in Project View",
    description: "Reveal and focus the active file in the project file tree",
    category: "Navigate",
    keybinding: "Alt+F1",
    provenance: "local",
    keywords: ["reveal", "tree", "project", "locate", "select in"],
  },
  "workspace.navigateBack":
  {
    id: "workspace.navigateBack",
    title: "Navigate Back",
    description: "Navigate back to previous cursor position in history",
    category: "Navigate",
    keybinding: "Ctrl+Alt+Left",
    provenance: "local",
    keywords: ["back", "navigation", "history"],
  },
  "workspace.navigateForward":
  {
    id: "workspace.navigateForward",
    title: "Navigate Forward",
    description: "Navigate forward in cursor position history",
    category: "Navigate",
    keybinding: "Ctrl+Alt+Right",
    provenance: "local",
    keywords: ["forward", "navigation", "history"],
  },
  "workspace.fileStructure":
  {
    id: "workspace.fileStructure",
    title: "File Structure Popup",
    description: "Show popup outline of symbols in current file",
    category: "Navigate",
    keybinding: "Ctrl+F12",
    provenance: "provider",
    keywords: ["structure", "outline", "symbols", "members"],
  },
  "workspace.gotoDefinition":
  {
    id: "workspace.gotoDefinition",
    title: "Go to Definition",
    description: "Jump to the definition of the symbol under cursor",
    category: "Navigate",
    keybinding: "F12",
    provenance: "provider",
    keywords: ["definition", "jump", "navigate"],
  },
  "workspace.gotoDeclaration":
  {
    id: "workspace.gotoDeclaration",
    title: "Go to Declaration",
    description: "Jump to the declaration of the symbol under cursor",
    category: "Navigate",
    keybinding: "Ctrl+B",
    secondaryKeybindings: ["Meta+B"],
    provenance: "provider",
    keywords: ["declaration", "jump", "navigate"],
  },
  "workspace.gotoTypeDefinition":
  {
    id: "workspace.gotoTypeDefinition",
    title: "Go to Type Definition",
    description: "Jump to the type definition of the symbol under cursor",
    category: "Navigate",
    keybinding: "Ctrl+Shift+B",
    provenance: "provider",
    keywords: ["type", "definition", "jump"],
  },
  "workspace.gotoImplementation":
  {
    id: "workspace.gotoImplementation",
    title: "Go to Implementation(s)",
    description: "Jump to implementations of interface or abstract method",
    category: "Navigate",
    keybinding: "Ctrl+Alt+B",
    provenance: "provider",
    keywords: ["implementation", "interface", "override"],
  },
  "workspace.callHierarchy":
  {
    id: "workspace.callHierarchy",
    title: "Call Hierarchy",
    description: "Explore callers and callees of active function/method",
    category: "Navigate",
    keybinding: "Ctrl+Alt+H",
    provenance: "provider",
    keywords: ["call", "hierarchy", "callers", "callees"],
  },
  "workspace.typeHierarchy":
  {
    id: "workspace.typeHierarchy",
    title: "Type Hierarchy",
    description: "Explore supertypes and subtypes hierarchy",
    category: "Navigate",
    keybinding: "Ctrl+H",
    provenance: "provider",
    keywords: ["type", "hierarchy", "supertypes", "subtypes"],
  },
  "workspace.findReferences":
  {
    id: "workspace.findReferences",
    title: "Find Usages",
    description: "Find usages and references across the project or scoped selection",
    category: "Navigate",
    keybinding: "Alt+F7",
    provenance: "provider",
    keywords: ["usages", "references", "callers", "find"],
  },
  "workspace.showUsages":
  {
    id: "workspace.showUsages",
    title: "Show Usages",
    description: "Show usages in a lightweight popup over the shared usages session",
    category: "Navigate",
    keybinding: "Ctrl+Alt+F7",
    provenance: "provider",
    keywords: ["usages", "popup", "lightweight"],
  },
  "workspace.previousMethod":
  {
    id: "workspace.previousMethod",
    title: "Previous Method",
    description: "Navigate to previous method or function declaration",
    category: "Navigate",
    keybinding: "Alt+Up",
    provenance: "unsupported",
    keywords: ["previous", "method", "function", "navigate"],
  },
  "workspace.nextMethod":
  {
    id: "workspace.nextMethod",
    title: "Next Method",
    description: "Navigate to next method or function declaration",
    category: "Navigate",
    keybinding: "Alt+Down",
    provenance: "unsupported",
    keywords: ["next", "method", "function", "navigate"],
  },
  "workspace.previousSibling":
  {
    id: "workspace.previousSibling",
    title: "Previous Sibling",
    description: "Navigate to previous sibling element or node",
    category: "Navigate",
    provenance: "unsupported",
    keywords: ["previous", "sibling", "element", "navigate"],
  },
  "workspace.nextSibling":
  {
    id: "workspace.nextSibling",
    title: "Next Sibling",
    description: "Navigate to next sibling element or node",
    category: "Navigate",
    provenance: "unsupported",
    keywords: ["next", "sibling", "element", "navigate"],
  },
  "workspace.activateNavigationBar":
  {
    id: "workspace.activateNavigationBar",
    title: "Jump to Navigation Bar",
    description: "Focus and navigate the project and symbol navigation bar",
    category: "Navigate",
    keybinding: "Alt+Home",
    provenance: "local",
    keywords: ["navbar", "navigation", "bar", "breadcrumbs", "jump"],
  },
  "workspace.highlightUsagesInFile":
  {
    id: "workspace.highlightUsagesInFile",
    title: "Highlight Usages in File",
    description: "Highlight all occurrences of the element at the caret in the current file",
    category: "Navigate",
    keybinding: "Ctrl+Shift+F7",
    provenance: "provider",
    keywords: ["highlight", "usages", "occurrences", "symbol"],
  },
  "workspace.nextOccurrence":
  {
    id: "workspace.nextOccurrence",
    title: "Next Highlighted Occurrence",
    description: "Navigate to the next occurrence of the highlighted element in file",
    category: "Navigate",
    keybinding: "Ctrl+Alt+Down",
    provenance: "local",
    keywords: ["next", "occurrence", "highlight"],
  },
  "workspace.previousOccurrence":
  {
    id: "workspace.previousOccurrence",
    title: "Previous Highlighted Occurrence",
    description: "Navigate to the previous occurrence of the highlighted element in file",
    category: "Navigate",
    keybinding: "Ctrl+Alt+Up",
    provenance: "local",
    keywords: ["previous", "occurrence", "highlight"],
  },
  "workspace.clearHighlightUsages":
  {
    id: "workspace.clearHighlightUsages",
    title: "Clear Highlight Usages",
    description: "Clear active occurrence highlights from the editor",
    category: "Navigate",
    keybinding: "Escape",
    provenance: "local",
    keywords: ["clear", "highlight", "escape"],
  }
};
