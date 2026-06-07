import {
  Download,
  FileText,
  FolderOpen,
  HelpCircle,
  PanelLeft,
  PanelTopClose,
  PanelTopOpen,
  Power,
  Plus,
  RefreshCw,
  Search,
  Terminal as TerminalIcon,
  Upload,
  X,
} from "lucide-react";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import type { RibbonCommand } from "./Ribbon";
import { useT } from "../../lib/i18n";
import { useSessionImportExport } from "./useSessionImportExport";

interface MenuBarProps {
  activeTabClosable: boolean;
  ribbonVisible: boolean;
  quickConnectVisible: boolean;
  onCommand: (command: RibbonCommand | "close-active" | "reload-sessions" | "toggle-quick-connect" | "toggle-ribbon") => void;
}

// Stable identifiers used for test IDs and underscore-name routing. Labels
// come from the locale dictionary so the visible text changes with the
// active language without affecting automation hooks.
type MenuId =
  | "terminal"
  | "sessions"
  | "view"
  | "x-server"
  | "tools"
  | "settings"
  | "macros"
  | "help"
  | "exit";

const MENU_LABEL_KEYS: Record<MenuId, string> = {
  terminal: "menu.terminal",
  sessions: "menu.sessions",
  view: "menu.view",
  "x-server": "menu.xserver",
  tools: "menu.tools",
  settings: "menu.settings",
  macros: "menu.macros",
  help: "menu.help",
  exit: "ribbon.exit",
};

export function MenuBar({ activeTabClosable, ribbonVisible, quickConnectVisible, onCommand }: MenuBarProps) {
  const ctx = useContextMenu();
  const t = useT();
  const {
    hasSessions,
    importJson,
    importMoba,
    importCsv,
    importOpenSsh,
    exportJson,
    exportMoba,
    exportCsv,
    exportHtml,
    previewNode,
  } = useSessionImportExport();
  const items: MenuId[] = [
    "terminal", "sessions", "view", "x-server", "tools", "settings", "macros", "help", "exit",
  ];

  const ribbonToggleItem = (): MenuItem => ({
    label: t("menu.toolButtonBar"),
    testId: "context-menu-item-toggle-ribbon",
    icon: <PanelTopOpen className="w-3 h-3" />,
    checked: ribbonVisible,
    onClick: () => onCommand("toggle-ribbon"),
  });

  const quickConnectToggleItem = (): MenuItem => ({
    label: t("menu.quickConnectToolbar"),
    testId: "context-menu-item-toggle-quick-connect",
    icon: <Search className="w-3 h-3" />,
    checked: quickConnectVisible,
    onClick: () => onCommand("toggle-quick-connect"),
  });

  const openMenu = (event: React.MouseEvent<HTMLButtonElement>, menu: MenuId) => {
    event.preventDefault();
    event.stopPropagation();

    if (menu === "exit") {
      onCommand("exit");
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const showMenu = (menuItems: MenuItem[]) => ctx.showAt(rect.left, rect.bottom, menuItems);

    if (menu === "terminal") {
      showMenu([
        { label: t("menu.newLocalTerminal"), testId: "context-menu-item-new-local-terminal", icon: <TerminalIcon className="w-3 h-3" />, onClick: () => onCommand("new-terminal") },
        { label: t("menu.newRemoteSession"), icon: <Plus className="w-3 h-3" />, onClick: () => onCommand("new-session") },
        { label: "", separator: true, onClick: () => {} },
        { label: t("menu.closeActiveTab"), icon: <X className="w-3 h-3" />, onClick: () => onCommand("close-active"), disabled: !activeTabClosable },
      ]);
      return;
    }

    if (menu === "sessions") {
      showMenu([
        { label: t("menu.newSession"), icon: <Plus className="w-3 h-3" />, onClick: () => onCommand("new-session") },
        { label: t("menu.showSessions"), icon: <FolderOpen className="w-3 h-3" />, onClick: () => onCommand("sessions") },
        { label: t("menu.reloadSessions"), testId: "context-menu-item-reload-sessions", icon: <RefreshCw className="w-3 h-3" />, onClick: () => onCommand("reload-sessions") },
        { label: "", separator: true },
        {
          label: t("menu.importSessions"),
          testId: "menu-import-sessions",
          icon: <Upload className="w-3 h-3" />,
          children: [
            { label: t("menu.importTaomni"), testId: "import-json", icon: <Upload className="w-3 h-3" />, onClick: importJson },
            { label: t("menu.importMobaXterm"), testId: "import-mobaxterm", icon: <Upload className="w-3 h-3" />, onClick: importMoba },
            { label: t("menu.importCsv"), testId: "import-csv", icon: <FileText className="w-3 h-3" />, onClick: importCsv },
            { label: t("menu.importOpenSsh"), testId: "import-openssh", icon: <TerminalIcon className="w-3 h-3" />, onClick: importOpenSsh },
          ],
        },
        {
          label: t("menu.exportSessions"),
          testId: "menu-export-sessions",
          icon: <Download className="w-3 h-3" />,
          disabled: !hasSessions,
          children: [
            { label: t("menu.exportTaomni"), testId: "export-json", icon: <Download className="w-3 h-3" />, onClick: exportJson },
            { label: t("menu.exportMobaXterm"), testId: "export-mobaxterm", icon: <Download className="w-3 h-3" />, onClick: exportMoba },
            { label: t("menu.exportCsv"), testId: "export-csv", icon: <FileText className="w-3 h-3" />, onClick: exportCsv },
            { label: t("menu.exportHtml"), testId: "export-html", icon: <FileText className="w-3 h-3" />, onClick: exportHtml },
          ],
        },
      ]);
      return;
    }

    if (menu === "view") {
      showMenu([
        ribbonToggleItem(),
        quickConnectToggleItem(),
        { label: "", separator: true },
        { label: t("menu.toggleSidebar"), icon: <PanelLeft className="w-3 h-3" />, onClick: () => onCommand("view") },
        { label: t("menu.toggleCompact"), icon: <PanelTopClose className="w-3 h-3" />, shortcut: "Ctrl+Shift+M", onClick: () => onCommand("toggle-compact") },
        { label: t("menu.splitTerminal"), icon: <PanelLeft className="w-3 h-3" />, onClick: () => onCommand("split") },
      ]);
      return;
    }

    if (menu === "x-server") {
      showMenu([
        { label: t("menu.toggleXServer"), onClick: () => onCommand("toggle-xserver") },
      ]);
      return;
    }

    if (menu === "help") {
      showMenu([
        { label: t("menu.aboutTaomni"), icon: <HelpCircle className="w-3 h-3" />, onClick: () => onCommand("help") },
      ]);
      return;
    }

    const command = menu as RibbonCommand;
    showMenu([
      { label: t("menu.openMenuFallback", { menu: t(MENU_LABEL_KEYS[menu]) }), onClick: () => onCommand(command) },
    ]);
  };

  const openChromeContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    ctx.show(event, [
      ribbonToggleItem(),
      quickConnectToggleItem(),
      { label: "", separator: true },
      { label: t("menu.toggleSidebar"), icon: <PanelLeft className="w-3 h-3" />, onClick: () => onCommand("view") },
      { label: t("menu.toggleCompact"), icon: <PanelTopClose className="w-3 h-3" />, shortcut: "Ctrl+Shift+M", onClick: () => onCommand("toggle-compact") },
    ]);
  };

  return (
    <div
      data-testid="menu-bar"
      className="h-6 flex items-center px-2 gap-3 border-b"
      onContextMenu={openChromeContextMenu}
      style={{
        borderColor: "var(--taomni-chrome-border)",
        background: "var(--taomni-menubar-bg)",
        fontSize: "var(--taomni-ui-font-size)",
      }}
    >
      {ctx.render}
      {previewNode}

      {items.map((id) => {
        const label = t(MENU_LABEL_KEYS[id]);
        return (
          <button
            key={id}
            data-testid={`menu-${id}`}
            className="px-1 hover:bg-[var(--taomni-hover)] rounded"
            onClick={(event) => openMenu(event, id)}
            onMouseEnter={(event) => {
              if (id === "exit") {
                if (ctx.isOpen) ctx.close();
                return;
              }
              if (ctx.isOpen) openMenu(event, id);
            }}
            type="button"
            title={id === "exit" ? t("ribbon.exit") : undefined}
          >
            {id === "exit" && <Power className="w-3 h-3 inline-block mr-1 align-[-1px]" style={{ color: "#b22222" }} />}
            <span className="underline-offset-2">
              <span className="underline">{label[0]}</span>
              {label.slice(1)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
