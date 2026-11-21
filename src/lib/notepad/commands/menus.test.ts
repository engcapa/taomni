import { describe, expect, it } from "vitest";
import { NOTEPAD_COMMAND_BY_ID, NOTEPAD_COMMAND_CATALOG } from "./catalog";
import { commandLabel } from "./labels";
import { NOTEPAD_MENUS, type NotepadMenuNode } from "./menus";

function walk(nodes: NotepadMenuNode[]): NotepadMenuNode[] {
  return nodes.flatMap((node) => (node.type === "submenu" ? [node, ...walk(node.items)] : [node]));
}

describe("notepad menu tree parity (AC-32, AC-46, prototype v3)", () => {
  it("exposes exactly the nine prototype top-level menus in order and no unsupported menus", () => {
    expect(NOTEPAD_MENUS.map((menu) => menu.id)).toEqual([
      "file",
      "edit",
      "search",
      "view",
      "encoding",
      "tools",
      "macro",
      "compare",
      "window",
    ]);
    // DEC-16: unsupported Notepad++ surfaces must never get an entry.
    const serialized = JSON.stringify(NOTEPAD_MENUS).toLowerCase();
    for (const forbidden of ["language", "plugins", "udl", "monitoring", "auto-completion", "code folding", "always on top"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(NOTEPAD_MENUS.some((menu) => menu.id === "help")).toBe(false);
  });

  it("references only registered commands and has unique submenu keys", () => {
    const allNodes = NOTEPAD_MENUS.flatMap((menu) => walk(menu.items));
    const commandIds = allNodes.filter((node) => node.type === "command").map((node) => (node as { id: string }).id);
    expect(commandIds.length).toBeGreaterThan(150);
    for (const id of commandIds) {
      expect(NOTEPAD_COMMAND_BY_ID.has(id), `menu references unknown command ${id}`).toBe(true);
    }
    const submenuKeys = allNodes.filter((node) => node.type === "submenu").map((node) => (node as { key: string }).key);
    expect(new Set(submenuKeys).size).toBe(submenuKeys.length);
    expect(new Set(commandIds).size).toBeGreaterThan(150);
  });

  it("declares the dynamic recent-files, saved-macros and documents nodes exactly once", () => {
    const types = NOTEPAD_MENUS.flatMap((menu) => walk(menu.items)).map((node) => node.type);
    expect(types.filter((type) => type === "recentFiles")).toHaveLength(1);
    expect(types.filter((type) => type === "savedMacros")).toHaveLength(1);
    expect(types.filter((type) => type === "documents")).toHaveLength(1);
  });

  it("keeps every catalog entry localizable and referenced by the catalog metadata", () => {
    for (const definition of NOTEPAD_COMMAND_CATALOG) {
      expect(definition.zhLabel, `${definition.id} is missing zhLabel`).toBeTruthy();
      expect(definition.defaultLabel).toBeTruthy();
      expect(definition.titleKey).toBeTruthy();
    }
    const find = NOTEPAD_COMMAND_BY_ID.get("file.save");
    expect(find).toBeDefined();
    expect(commandLabel(find!, "zh-CN")).toBe(find!.zhLabel);
    expect(commandLabel(find!, "en")).toBe(find!.defaultLabel);
  });

  it("keeps one default shortcut per command (V-07 keymap baseline)", () => {
    const seen = new Map<string, string>();
    for (const definition of NOTEPAD_COMMAND_CATALOG) {
      const shortcut = definition.defaultShortcut ?? definition.macosShortcut;
      if (!shortcut) continue;
      const previous = seen.get(shortcut);
      expect(previous, `duplicate default shortcut ${shortcut} on ${definition.id} and ${previous}`).toBeUndefined();
      seen.set(shortcut, definition.id);
    }
  });
});
