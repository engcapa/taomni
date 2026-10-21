import { type WorkspaceActionMetadata } from "../types";

export const movementActionMetadata: Record<string, WorkspaceActionMetadata> = {
  "editor.moveUp":
  // --- Editor Movement & Virtual Space ---
  {
    id: "editor.moveUp",
    title: "Up",
    description: "Move caret up one line, preserving virtual space column if enabled",
    category: "Navigate",
    keybinding: "ArrowUp",
    provenance: "local",
    keywords: ["up", "cursor", "line", "virtual space"],
  },
  "editor.moveDown":
  {
    id: "editor.moveDown",
    title: "Down",
    description: "Move caret down one line, preserving virtual space column if enabled",
    category: "Navigate",
    keybinding: "ArrowDown",
    provenance: "local",
    keywords: ["down", "cursor", "line", "virtual space"],
  },
  "editor.selectUp":
  {
    id: "editor.selectUp",
    title: "Select Up",
    description: "Extend selection up one line, preserving virtual space column if enabled",
    category: "Navigate",
    keybinding: "Shift+ArrowUp",
    provenance: "local",
    keywords: ["up", "select", "virtual space"],
  },
  "editor.selectDown":
  {
    id: "editor.selectDown",
    title: "Select Down",
    description: "Extend selection down one line, preserving virtual space column if enabled",
    category: "Navigate",
    keybinding: "Shift+ArrowDown",
    provenance: "local",
    keywords: ["down", "select", "virtual space"],
  },
  "editor.pageUp":
  {
    id: "editor.pageUp",
    title: "Page Up",
    description: "Move caret up one page",
    category: "Navigate",
    keybinding: "PageUp",
    provenance: "local",
    keywords: ["page", "up", "scroll", "virtual space"],
  },
  "editor.selectPageUp":
  {
    id: "editor.selectPageUp",
    title: "Select Page Up",
    description: "Extend selection up one page",
    category: "Navigate",
    keybinding: "Shift+PageUp",
    provenance: "local",
    keywords: ["page", "up", "select", "virtual space"],
  },
  "editor.pageDown":
  {
    id: "editor.pageDown",
    title: "Page Down",
    description: "Move caret down one page",
    category: "Navigate",
    keybinding: "PageDown",
    provenance: "local",
    keywords: ["page", "down", "scroll", "virtual space"],
  },
  "editor.selectPageDown":
  {
    id: "editor.selectPageDown",
    title: "Select Page Down",
    description: "Extend selection down one page",
    category: "Navigate",
    keybinding: "Shift+PageDown",
    provenance: "local",
    keywords: ["page", "down", "select", "virtual space"],
  },
  "editor.moveLeft":
  {
    id: "editor.moveLeft",
    title: "Left",
    description: "Move caret left",
    category: "Navigate",
    keybinding: "ArrowLeft",
    provenance: "local",
    keywords: ["left", "cursor", "virtual space"],
  },
  "editor.selectLeft":
  {
    id: "editor.selectLeft",
    title: "Select Left",
    description: "Extend selection left",
    category: "Navigate",
    keybinding: "Shift+ArrowLeft",
    provenance: "local",
    keywords: ["left", "select", "virtual space"],
  },
  "editor.moveRight":
  {
    id: "editor.moveRight",
    title: "Right",
    description: "Move caret right",
    category: "Navigate",
    keybinding: "ArrowRight",
    provenance: "local",
    keywords: ["right", "cursor", "virtual space"],
  },
  "editor.selectRight":
  {
    id: "editor.selectRight",
    title: "Select Right",
    description: "Extend selection right",
    category: "Navigate",
    keybinding: "Shift+ArrowRight",
    provenance: "local",
    keywords: ["right", "select", "virtual space"],
  },
  "editor.moveToLineStart":
  {
    id: "editor.moveToLineStart",
    title: "Move to Line Start",
    description: "Move caret to line start",
    category: "Navigate",
    keybinding: "Home",
    provenance: "local",
    keywords: ["home", "start", "line"],
  },
  "editor.moveToLineEnd":
  {
    id: "editor.moveToLineEnd",
    title: "Move to Line End",
    description: "Move caret to line end or past EOL in virtual space",
    category: "Navigate",
    keybinding: "End",
    provenance: "local",
    keywords: ["end", "line", "virtual space"],
  },
  "editor.selectToLineEnd":
  {
    id: "editor.selectToLineEnd",
    title: "Select to Line End",
    description: "Extend selection to line end or past EOL in virtual space",
    category: "Navigate",
    keybinding: "Shift+End",
    provenance: "local",
    keywords: ["end", "line", "select", "virtual space"],
  }
};
