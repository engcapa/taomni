import { describe, expect, it } from "vitest";
import { NOTEPAD_COMMAND_CATALOG } from "../../../lib/notepad/commands/catalog";

const FORBIDDEN_LABELS = [
  "Language",
  "User Defined Language",
  "UDL",
  "Plugins",
  "Plugins Admin",
  "Run Menu",
  "Monitoring (tail -f)",
  "Folder as Workspace",
  "Project Panel",
  "Always on Top",
  "Multi-Instance",
  "Context Menu Config",
  "Code Folding",
  "Auto-Completion",
  "Syntax Highlight",
  "Brace Matching",
  "Comment Line",
  "Auto-Indent",
  "Updater",
];

describe("DEC-16 unsupported feature exclusion guard (V-38)", () => {
  it("contains zero command catalog entries or categories for excluded Notepad++ features", () => {
    const categories = new Set(NOTEPAD_COMMAND_CATALOG.map((c) => c.category));
    expect([...categories].sort()).toEqual([
      "encoding",
      "edit",
      "file",
      "help",
      "macro",
      "search",
      "tools",
      "view",
      "window",
    ].sort());

    const serialized = JSON.stringify(NOTEPAD_COMMAND_CATALOG).toLowerCase();
    for (const forbidden of FORBIDDEN_LABELS) {
      expect(serialized).not.toContain(forbidden.toLowerCase());
    }
    expect(serialized).not.toContain("language.");
    expect(serialized).not.toContain("plugins.");
    expect(serialized).not.toContain("udl");
    expect(serialized).not.toContain("monitor");
  });
});
