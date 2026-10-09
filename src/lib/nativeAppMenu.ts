import type { AppCommand } from "../components/menubar/commands";
import type { WorkspaceCommandMenuItem } from "../components/editor/workspace/workspaceCommands";
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
  | "export-html"
  | `workspace-command:${string}`;

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
  /** Commands contributed by the active Code Workspace tab. */
  workspaceCommands?: WorkspaceCommandMenuItem[];
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
    workspaceCommands = [],
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
    { type: "item", id: "servers", label: t("servers.dialogTitle"), action: "servers" },
    { type: "item", id: "tunneling", label: t("menu.tunneling"), action: "tunneling" },
    { type: "item", id: "sockscap", label: t("menu.sockscap"), action: "sockscap" },
    { type: "item", id: "git", label: t("menu.gitRepository"), action: "git" },
    { type: "item", id: "code-workspace", label: t("menu.codeWorkspace"), action: "code-workspace" },
    { type: "item", id: "mail-unified", label: t("tabs.mailUnified"), action: "mail-unified" },
    { type: "item", id: "lan-chat", label: t("tabs.lanChat"), action: "lan-chat" },
    { type: "item", id: "mfa", label: t("menu.mfa"), action: "mfa" },
    { type: "item", id: "network-tools", label: t("menu.networkTools"), action: "tools" },
    { type: "separator" },
    { type: "item", id: "settings", label: t("menu.settings"), action: "settings", accelerator: "CmdOrCtrl+," },
  ];
  if (workspaceCommands.length > 0) {
    toolsMenu.splice(toolsMenu.length - 2, 0,
      { type: "separator" },
      {
        type: "submenu",
        id: "code-workspace-actions",
        label: t("menu.codeWorkspaceActions"),
        items: workspaceCommands.map((command): MenuNodeSpec => ({
          type: "item",
          id: `workspace-command-${command.id}`,
          label: command.title,
          action: `workspace-command:${command.id}`,
          enabled: command.enabled,
          ...(command.keybinding ? { accelerator: command.keybinding.replace(/^Ctrl\+/, "CmdOrCtrl+") } : {}),
        })),
      },
    );
  }

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

type NativeMenuApi = typeof import("@tauri-apps/api/menu");
type NativeMenuItem = Awaited<ReturnType<NativeMenuApi["MenuItem"]["new"]>>
  | Awaited<ReturnType<NativeMenuApi["CheckMenuItem"]["new"]>>
  | Awaited<ReturnType<NativeMenuApi["PredefinedMenuItem"]["new"]>>
  | Awaited<ReturnType<NativeMenuApi["Submenu"]["new"]>>;
type NativeMenuResource = NativeMenuItem | Awaited<ReturnType<NativeMenuApi["Menu"]["new"]>>;

let installationRevision = 0;
let installedRevision = 0;
let installedResources: NativeMenuResource[] = [];
let installationQueue = Promise.resolve();

export function appMenuInstallationReady(): boolean {
  return installedRevision > 0 && installedRevision === installationRevision;
}

// Observe installation in this document. A WebView reload can temporarily
// leave AppKit showing the previous document's menu and dead JS callbacks.
if (__TAOMNI_QA_UPDATER__) {
  (globalThis as typeof globalThis & {
    __TAOMNI_QA_APP_MENU__?: { ready: () => boolean };
  }).__TAOMNI_QA_APP_MENU__ = { ready: appMenuInstallationReady };
}

async function closeResources(resources: NativeMenuResource[]): Promise<void> {
  const results = await Promise.allSettled(resources.reverse().map((resource) => resource.close()));
  for (const result of results) {
    if (result.status === "rejected") console.error("Failed to release native menu resource", result.reason);
  }
}

async function finishCreations<T>(creations: Promise<T>[]): Promise<T[]> {
  // Let every sibling finish before cleanup so a failed IPC call cannot
  // leave a late-created menu resource outside the cleanup ledger.
  const results = await Promise.allSettled(creations);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
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
  const revision = ++installationRevision;
  const api = await import("@tauri-apps/api/menu");
  // Tauri 2.12 drops the temporary wrappers built from nested option objects,
  // which unregisters their JS action channels. Explicit resource handles
  // keep every item alive until its menu is replaced.
  const prefix = `app-menu-${crypto.randomUUID()}`;
  const resources: NativeMenuResource[] = [];
  const own = <T extends NativeMenuResource>(resource: T): T => {
    resources.push(resource);
    return resource;
  };
  const materialize = async (node: MenuNodeSpec): Promise<NativeMenuItem> => {
    switch (node.type) {
      case "separator":
        return own(await api.PredefinedMenuItem.new({ item: "Separator" }));
      case "predefined":
        return own(await api.PredefinedMenuItem.new({ item: node.item, text: node.label }));
      case "item":
        return own(await api.MenuItem.new({
          id: `${prefix}-${node.id}`, text: node.label, enabled: node.enabled ?? true,
          accelerator: node.accelerator, action: () => dispatch(node.action),
        }));
      case "check":
        return own(await api.CheckMenuItem.new({
          id: `${prefix}-${node.id}`, text: node.label, checked: node.checked,
          action: () => dispatch(node.action),
        }));
      case "submenu": {
        const items = await finishCreations(node.items.map(materialize));
        return own(await api.Submenu.new({
          id: `${prefix}-${node.id}`, text: node.label, enabled: node.enabled ?? true, items,
        }));
      }
    }
  };
  try {
    const items = await finishCreations(spec.submenus.map(async (submenu) => {
      const children = await finishCreations(submenu.items.map(materialize));
      return own(await api.Submenu.new({ id: `${prefix}-${submenu.id}`, text: submenu.label, items: children }));
    }));
    const menu = own(await api.Menu.new({ items }));
    const install = installationQueue.then(async () => {
      if (revision !== installationRevision) {
        await closeResources(resources);
        return;
      }
      const replaced = await menu.setAsAppMenu();
      const previous = installedResources;
      installedResources = resources;
      // IDs are unique to this installation, so old resources cannot remove
      // the new menu's channels when their native wrappers are released.
      await closeResources(previous);
      // setAsAppMenu also returns a new handle to the previous root menu.
      if (replaced) await closeResources([replaced]);
      installedRevision = revision;
    });
    installationQueue = install.catch(() => {});
    await install;
  } catch (error) {
    await closeResources(resources);
    throw error;
  }
}
