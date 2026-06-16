import { describe, it, expect } from "vitest";
import {
  buildAppMenuSpec,
  type AppMenuSpec,
  type MenuNodeSpec,
} from "./nativeAppMenu";

// Identity translator so assertions read against i18n keys, not localized text.
const idT = (key: string) => key;

function submenu(spec: AppMenuSpec, id: string) {
  const found = spec.submenus.find((s) => s.id === id);
  if (!found) throw new Error(`submenu ${id} not found`);
  return found;
}

function flatten(nodes: MenuNodeSpec[]): MenuNodeSpec[] {
  return nodes.flatMap((node) =>
    node.type === "submenu" ? [node, ...flatten(node.items)] : [node],
  );
}

function actions(nodes: MenuNodeSpec[]): string[] {
  const result: string[] = [];
  for (const node of flatten(nodes)) {
    if ("action" in node && typeof node.action === "string") {
      result.push(node.action);
    }
  }
  return result;
}

const baseParams = {
  activeTabClosable: true,
  hasSessions: true,
  quickConnectVisible: false,
  t: idT,
};

describe("buildAppMenuSpec", () => {
  it("exposes the expected top-level menus in order", () => {
    const spec = buildAppMenuSpec(baseParams);
    expect(spec.submenus.map((s) => s.id)).toEqual([
      "app",
      "terminal",
      "sessions",
      "edit",
      "view",
      "x-server",
      "tools",
      "window",
      "help",
    ]);
  });

  it("puts Quit in the app menu, not next to Help", () => {
    const spec = buildAppMenuSpec(baseParams);
    const app = submenu(spec, "app");
    const quit = app.items.find((n) => n.type === "item" && n.id === "quit");
    expect(quit).toBeDefined();
    expect(quit && quit.type === "item" && quit.action).toBe("exit");
    expect(quit && quit.type === "item" && quit.accelerator).toBe("CmdOrCtrl+Q");

    // Help menu must not contain a standalone exit/quit entry.
    const help = submenu(spec, "help");
    expect(actions(help.items)).not.toContain("exit");
  });

  it("never offers compact mode", () => {
    const spec = buildAppMenuSpec(baseParams);
    const allActions = spec.submenus.flatMap((s) => actions(s.items));
    expect(allActions).not.toContain("toggle-compact");
  });

  it("includes a standard Edit menu of predefined items", () => {
    const spec = buildAppMenuSpec(baseParams);
    const edit = submenu(spec, "edit");
    const predefined = edit.items
      .filter((n): n is Extract<MenuNodeSpec, { type: "predefined" }> => n.type === "predefined")
      .map((n) => n.item);
    expect(predefined).toEqual([
      "Undo",
      "Redo",
      "Cut",
      "Copy",
      "Paste",
      "SelectAll",
    ]);
  });

  it("includes a standard Window menu", () => {
    const spec = buildAppMenuSpec(baseParams);
    const win = submenu(spec, "window");
    const predefined = win.items
      .filter((n): n is Extract<MenuNodeSpec, { type: "predefined" }> => n.type === "predefined")
      .map((n) => n.item);
    expect(predefined).toContain("Minimize");
    expect(predefined).toContain("BringAllToFront");
  });

  it("disables Close active tab when no closable tab is active", () => {
    const spec = buildAppMenuSpec({ ...baseParams, activeTabClosable: false });
    const terminal = submenu(spec, "terminal");
    const close = terminal.items.find((n) => n.type === "item" && n.id === "close-active");
    expect(close && close.type === "item" && close.enabled).toBe(false);
  });

  it("disables Export sessions when there are no sessions", () => {
    const spec = buildAppMenuSpec({ ...baseParams, hasSessions: false });
    const sessions = submenu(spec, "sessions");
    const exportNode = sessions.items.find(
      (n) => n.type === "submenu" && n.id === "export-sessions",
    );
    expect(exportNode && exportNode.type === "submenu" && exportNode.enabled).toBe(false);
  });

  it("reflects toolbar visibility as checkmarks in the View menu", () => {
    const spec = buildAppMenuSpec({
      ...baseParams,
      quickConnectVisible: true,
    });
    const view = submenu(spec, "view");
    const quick = view.items.find((n) => n.type === "check" && n.id === "toggle-quick-connect");
    expect(quick && quick.type === "check" && quick.checked).toBe(true);
  });

  it("wires import/export actions for every format", () => {
    const spec = buildAppMenuSpec(baseParams);
    const sessions = submenu(spec, "sessions");
    const acts = actions(sessions.items);
    for (const a of [
      "import-json",
      "import-moba",
      "import-csv",
      "import-openssh",
      "export-json",
      "export-moba",
      "export-csv",
      "export-html",
    ]) {
      expect(acts).toContain(a);
    }
  });
});
