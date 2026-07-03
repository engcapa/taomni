import type { AppCommand } from "../components/menubar/commands";
import { t as translate } from "./i18n";

/**
 * Native macOS application menu. The menu is built as a pure, testable data
 * spec ({@link buildAppMenuSpec}) and then materialized into real Tauri menu
 * objects ({@link installAppMenu}). All menu activations route back through a
 * single {@link MenuActionId} so the wiring in MainLayout reuses the existing
 * `handleCommand` switch plus the session import/export hook.
 */

export type MenuActionId =
  | AppCommand
  | "import-json"
  | "import-moba"
  | "import-csv"
  | "download-csv-template"
  | "import-openssh"
  | "export-json"
  | "export-moba"
  | "export-csv"
  | "export-html";

/** Predefined (OS-provided) menu item kinds we use. */
export type PredefinedKind =
  | "Separator"
  | "Services"
  | "Hide"
  | "HideOthers"
  | "ShowAll"
  | "Undo"
  | "Redo"
  | "Cut"
  | "Copy"
  | "Paste"
  | "SelectAll"
  | "Minimize"
  | "Maximize"
  | "BringAllToFront";

export type MenuNodeSpec =
  | {
      type: "item";
      id: string;
      label: string;
      action: MenuActionId;
      enabled?: boolean;
      accelerator?: string;
    }
  | {
      type: "check";
      id: string;
      label: string;
      action: MenuActionId;
      checked: boolean;
    }
  | { type: "predefined"; item: PredefinedKind; label?: string }
  | { type: "separator" }
  | {
      type: "submenu";
      id: string;
      label: string;
      items: MenuNodeSpec[];
      enabled?: boolean;
    };

export interface AppMenuSpec {
  /** Top-level submenus. On macOS the first one becomes the app menu. */
  submenus: Array<{ id: string; label: string; items: MenuNodeSpec[] }>;
}

export interface BuildAppMenuParams {
  /** Whether the active tab can be closed (mirrors `activeTabClosable`). */
  activeTabClosable: boolean;
  /** Whether any saved sessions exist (controls Export enablement). */
  hasSessions: boolean;
  /** Quick-connect toolbar visibility — shown as a checkmark. */
  quickConnectVisible: boolean;
  /** Translation function (defaults to the module-level `t`). */
  t?: (key: string, vars?: Record<string, string | number>) => string;
}

/**
 * Build the macOS application-menu spec. Pure: no Tauri imports, no side
 * effects — safe to snapshot in unit tests. Compact mode is intentionally
 * absent (removed on macOS); Quit lives in the app menu, not next to Help.
 */
export function buildAppMenuSpec(params: BuildAppMenuParams): AppMenuSpec {
  const {
    activeTabClosable,
    hasSessions,
    quickConnectVisible,
    t = translate,
  } = params;

  const appMenu: MenuNodeSpec[] = [
    { type: "item", id: "about", label: t("menu.aboutTaomni"), action: "help" },
    { type: "separator" },
    { type: "predefined", item: "Services", label: t("menu.services") },
    { type: "separator" },
    { type: "predefined", item: "Hide", label: t("menu.hide") },
    { type: "predefined", item: "HideOthers", label: t("menu.hideOthers") },
    { type: "predefined", item: "ShowAll", label: t("menu.showAll") },
    { type: "separator" },
    {
      type: "item",
      id: "quit",
      label: t("menu.quit"),
      action: "exit",
      accelerator: "CmdOrCtrl+Q",
    },
  ];

  const terminalMenu: MenuNodeSpec[] = [
    { type: "item", id: "new-terminal", label: t("menu.newLocalTerminal"), action: "new-terminal" },
    { type: "item", id: "new-session", label: t("menu.newRemoteSession"), action: "new-session" },
    { type: "separator" },
    {
      type: "item",
      id: "close-active",
      label: t("menu.closeActiveTab"),
      action: "close-active",
      enabled: activeTabClosable,
    },
  ];

  const sessionsMenu: MenuNodeSpec[] = [
    { type: "item", id: "sessions-new", label: t("menu.newSession"), action: "new-session" },
    { type: "item", id: "sessions-show", label: t("menu.showSessions"), action: "sessions" },
    { type: "item", id: "sessions-reload", label: t("menu.reloadSessions"), action: "reload-sessions" },
    { type: "separator" },
    {
      type: "submenu",
      id: "import-sessions",
      label: t("menu.importSessions"),
      items: [
        { type: "item", id: "import-json", label: t("menu.importTaomni"), action: "import-json" },
        { type: "item", id: "import-moba", label: t("menu.importMobaXterm"), action: "import-moba" },
        { type: "item", id: "import-csv", label: t("menu.importCsv"), action: "import-csv" },
        { type: "item", id: "download-csv-template", label: t("menu.downloadCsvTemplate"), action: "download-csv-template" },
        { type: "item", id: "import-openssh", label: t("menu.importOpenSsh"), action: "import-openssh" },
      ],
    },
    {
      type: "submenu",
      id: "export-sessions",
      label: t("menu.exportSessions"),
      enabled: hasSessions,
      items: [
        { type: "item", id: "export-json", label: t("menu.exportTaomni"), action: "export-json" },
        { type: "item", id: "export-moba", label: t("menu.exportMobaXterm"), action: "export-moba" },
        { type: "item", id: "export-csv", label: t("menu.exportCsv"), action: "export-csv" },
        { type: "item", id: "export-html", label: t("menu.exportHtml"), action: "export-html" },
      ],
    },
  ];

  const editMenu: MenuNodeSpec[] = [
    { type: "predefined", item: "Undo", label: t("menu.undo") },
    { type: "predefined", item: "Redo", label: t("menu.redo") },
    { type: "separator" },
    { type: "predefined", item: "Cut", label: t("menu.cut") },
    { type: "predefined", item: "Copy", label: t("menu.copy") },
    { type: "predefined", item: "Paste", label: t("menu.paste") },
    { type: "predefined", item: "SelectAll", label: t("menu.selectAll") },
  ];

  const viewMenu: MenuNodeSpec[] = [
    { type: "check", id: "toggle-quick-connect", label: t("menu.quickConnectToolbar"), action: "toggle-quick-connect", checked: quickConnectVisible },
    { type: "separator" },
    { type: "item", id: "toggle-sidebar", label: t("menu.toggleSidebar"), action: "view" },
    { type: "item", id: "split", label: t("menu.splitTerminal"), action: "split" },
  ];

  const xServerMenu: MenuNodeSpec[] = [
    { type: "item", id: "toggle-xserver", label: t("menu.toggleXServer"), action: "toggle-xserver" },
  ];

  const toolsMenu: MenuNodeSpec[] = [
    { type: "item", id: "tunneling", label: t("menu.tunneling"), action: "tunneling" },
    { type: "item", id: "code-workspace", label: "Code Workspace...", action: "code-workspace" },
    { type: "item", id: "lan-chat", label: t("tabs.lanChat"), action: "lan-chat" },
    { type: "item", id: "network-tools", label: t("menu.networkTools"), action: "tools" },
    { type: "item", id: "packages", label: t("menu.packages"), action: "packages" },
    { type: "item", id: "macros", label: t("menu.macros"), action: "macros" },
    { type: "separator" },
    { type: "item", id: "settings", label: t("menu.settings"), action: "settings", accelerator: "CmdOrCtrl+," },
  ];

  const windowMenu: MenuNodeSpec[] = [
    { type: "predefined", item: "Minimize", label: t("menu.windowMinimize") },
    { type: "predefined", item: "Maximize", label: t("menu.windowZoom") },
    { type: "separator" },
    { type: "predefined", item: "BringAllToFront", label: t("menu.bringAllToFront") },
  ];

  const helpMenu: MenuNodeSpec[] = [
    { type: "item", id: "help-about", label: t("menu.aboutTaomni"), action: "help" },
  ];

  return {
    submenus: [
      { id: "app", label: t("menu.appMenu"), items: appMenu },
      { id: "terminal", label: t("menu.terminal"), items: terminalMenu },
      { id: "sessions", label: t("menu.sessions"), items: sessionsMenu },
      { id: "edit", label: t("menu.edit"), items: editMenu },
      { id: "view", label: t("menu.view"), items: viewMenu },
      { id: "x-server", label: t("menu.xserver"), items: xServerMenu },
      { id: "tools", label: t("menu.tools"), items: toolsMenu },
      { id: "window", label: t("menu.window"), items: windowMenu },
      { id: "help", label: t("menu.help"), items: helpMenu },
    ],
  };
}

// Tauri menu option shapes — typed loosely here so this module stays
// importable in jsdom tests without pulling the @tauri-apps/api/menu runtime.
type TauriMenuItemOptions =
  | { item: PredefinedKind; text?: string }
  | { id: string; text: string; enabled?: boolean; accelerator?: string; action?: (id: string) => void }
  | { id: string; text: string; checked: boolean; action?: (id: string) => void }
  | { id: string; text: string; enabled?: boolean; items: TauriMenuItemOptions[] };

function nodeToOptions(
  node: MenuNodeSpec,
  dispatch: (action: MenuActionId) => void,
): TauriMenuItemOptions {
  switch (node.type) {
    case "separator":
      return { item: "Separator" };
    case "predefined":
      return node.label ? { item: node.item, text: node.label } : { item: node.item };
    case "item":
      return {
        id: node.id,
        text: node.label,
        enabled: node.enabled ?? true,
        ...(node.accelerator ? { accelerator: node.accelerator } : {}),
        action: () => dispatch(node.action),
      };
    case "check":
      return {
        id: node.id,
        text: node.label,
        checked: node.checked,
        action: () => dispatch(node.action),
      };
    case "submenu":
      return {
        id: node.id,
        text: node.label,
        enabled: node.enabled ?? true,
        items: node.items.map((child) => nodeToOptions(child, dispatch)),
      };
  }
}

/**
 * Materialize the spec into a native menu and set it as the application menu.
 * macOS-only in practice; safe to call from a guarded effect. Returns once the
 * menu has been installed. The {@link dispatch} callback routes each item's
 * {@link MenuActionId} back to the host (handleCommand / import-export hook).
 */
export async function installAppMenu(
  spec: AppMenuSpec,
  dispatch: (action: MenuActionId) => void,
): Promise<void> {
  const { Menu } = await import("@tauri-apps/api/menu");
  const items = spec.submenus.map((submenu) => ({
    id: submenu.id,
    text: submenu.label,
    items: submenu.items.map((node) => nodeToOptions(node, dispatch)),
  }));
  // The option-object form lets Tauri build the whole tree (submenus +
  // predefined + check items) in one round-trip.
  const menu = await Menu.new({ items: items as never });
  await menu.setAsAppMenu();
}
