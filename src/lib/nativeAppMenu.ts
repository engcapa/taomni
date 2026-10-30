import { t as translate } from "./i18n";
import type { AppMenuSpec, BuildAppMenuParams, MenuNodeSpec } from "./nativeAppMenuSpec";

export type { AppMenuSpec, BuildAppMenuParams, MenuActionId, MenuNodeSpec, PredefinedKind } from "./nativeAppMenuSpec";
export { appMenuInstallationReady, installAppMenu } from "./nativeAppMenuInstaller";

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
