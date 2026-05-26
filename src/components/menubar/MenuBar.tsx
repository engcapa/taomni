import { useState } from "react";
import {
  Download,
  FileText,
  FolderOpen,
  HelpCircle,
  PanelLeft,
  PanelTopClose,
  Plus,
  RefreshCw,
  Terminal as TerminalIcon,
  Upload,
  X,
} from "lucide-react";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import type { RibbonCommand } from "./Ribbon";
import { useSessionStore } from "../../stores/sessionStore";
import { useAppStore } from "../../stores/appStore";
import { openBinaryFile, openTextFile, downloadTextFile } from "../../lib/fileHelpers";
import { parseOpenSshConfig } from "../../lib/quickConnect";
import { serializeHtmlSessions } from "../../lib/sessionExportHtml";
import {
  createSessionImportResult,
  parseCsvSessions,
  parseMobaXtermSessions,
  parseNewMobSessions,
  serializeCsvSessions,
  serializeMobaXtermSessions,
  serializeNewMobSessions,
  type SessionExportResult,
  type SessionImportResult,
} from "../../lib/sessionImportExport";
import { SessionImportPreview } from "../session/SessionImportPreview";
import { useT, t as translate } from "../../lib/i18n";

interface MenuBarProps {
  activeTabClosable: boolean;
  onCommand: (command: RibbonCommand | "close-active" | "reload-sessions") => void;
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
  | "help";

const MENU_LABEL_KEYS: Record<MenuId, string> = {
  terminal: "menu.terminal",
  sessions: "menu.sessions",
  view: "menu.view",
  "x-server": "menu.xserver",
  tools: "menu.tools",
  settings: "menu.settings",
  macros: "menu.macros",
  help: "menu.help",
};

export function MenuBar({ activeTabClosable, onCommand }: MenuBarProps) {
  const ctx = useContextMenu();
  const { sessions, importSessions } = useSessionStore();
  const { setStatusMessage } = useAppStore();
  const t = useT();
  const [pendingImport, setPendingImport] = useState<{
    result: SessionImportResult;
    source: string;
  } | null>(null);
  const items: MenuId[] = [
    "terminal", "sessions", "view", "x-server", "tools", "settings", "macros", "help",
  ];
  const hasSessions = sessions.length > 0;

  const queueImportPreview = (result: SessionImportResult, source: string) => {
    setPendingImport({ result, source });
  };

  const confirmPendingImport = async () => {
    const pending = pendingImport;
    if (!pending) return;
    if (pending.result.sessions.length > 0) {
      await importSessions(pending.result.sessions);
    }
    setStatusMessage(importStatusMessage(pending.source, pending.result));
    setPendingImport(null);
  };

  const importJson = () => {
    openTextFile(".json,.newmob-sessions.json,application/json").then((text) => {
      if (!text) return;
      queueImportPreview(parseNewMobSessions(text, { existingSessions: sessions }), "NewMob");
    }).catch(reportError);
  };

  const importMoba = () => {
    openBinaryFile(".mxtsessions,.moba,text/plain,application/octet-stream").then((bytes) => {
      if (!bytes) return;
      queueImportPreview(parseMobaXtermSessions(bytes, { existingSessions: sessions }), "MobaXterm");
    }).catch(reportError);
  };

  const importCsv = () => {
    openTextFile(".csv,text/csv").then((text) => {
      if (!text) return;
      queueImportPreview(parseCsvSessions(text, { existingSessions: sessions }), "CSV");
    }).catch(reportError);
  };

  const importOpenSsh = () => {
    openTextFile(".config,.txt,*").then((text) => {
      if (!text) return;
      const parsed = parseOpenSshConfig(text);
      queueImportPreview(createSessionImportResult(parsed, { existingSessions: sessions }), "OpenSSH");
    }).catch(reportError);
  };

  const exportResult = (format: string, result: SessionExportResult) => {
    downloadTextFile(result.filename, result.text, result.mimeType);
    const count = sessions.length - result.skipped;
    const skipped = result.skipped ? translate("status.skippedSuffix", { count: result.skipped }) : "";
    const warningSuffix = result.warnings.length
      ? translate("status.warningsSuffix", { count: result.warnings.length, plural: result.warnings.length === 1 ? "" : "s" })
      : "";
    setStatusMessage(translate("status.exportedSessions", {
      count,
      format,
      plural: count === 1 ? "" : "s",
      skipped,
      warnings: warningSuffix,
    }));
    if (result.warnings.length) {
      window.alert(result.warnings.slice(0, 8).join("\n"));
    }
  };

  const exportJson = () => exportResult("NewMob", serializeNewMobSessions(sessions, null));
  const exportMoba = () => exportResult("MobaXterm", serializeMobaXtermSessions(sessions, null));
  const exportCsv = () => exportResult("CSV", serializeCsvSessions(sessions, null));
  const exportHtml = () => exportResult("HTML", serializeHtmlSessions(sessions, null));

  const openMenu = (event: React.MouseEvent<HTMLButtonElement>, menu: MenuId) => {
    event.preventDefault();
    event.stopPropagation();

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
            { label: t("menu.importNewMob"), testId: "import-json", icon: <Upload className="w-3 h-3" />, onClick: importJson },
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
            { label: t("menu.exportNewMob"), testId: "export-json", icon: <Download className="w-3 h-3" />, onClick: exportJson },
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
        { label: t("menu.aboutNewMob"), icon: <HelpCircle className="w-3 h-3" />, onClick: () => onCommand("help") },
      ]);
      return;
    }

    const command = menu as RibbonCommand;
    showMenu([
      { label: t("menu.openMenuFallback", { menu: t(MENU_LABEL_KEYS[menu]) }), onClick: () => onCommand(command) },
    ]);
  };

  return (
    <div
      data-testid="menu-bar"
      className="h-6 flex items-center px-2 gap-3 border-b"
      style={{
        borderColor: "var(--moba-chrome-border)",
        background: "var(--moba-menubar-bg)",
        fontSize: "var(--moba-ui-font-size)",
      }}
    >
      {ctx.render}
      {pendingImport && (
        <SessionImportPreview
          source={pendingImport.source}
          result={pendingImport.result}
          targetFolder={null}
          onCancel={() => setPendingImport(null)}
          onConfirm={() => void confirmPendingImport()}
        />
      )}
      {items.map((id) => {
        const label = t(MENU_LABEL_KEYS[id]);
        return (
          <button
            key={id}
            data-testid={`menu-${id}`}
            className="px-1 hover:bg-[var(--moba-hover)] rounded"
            onClick={(event) => openMenu(event, id)}
            onMouseEnter={(event) => {
              if (ctx.isOpen) openMenu(event, id);
            }}
            type="button"
          >
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

function importStatusMessage(source: string, result: SessionImportResult): string {
  const count = result.sessions.length;
  const skipped = result.skipped ? translate("status.skippedSuffix", { count: result.skipped }) : "";
  const warningSuffix = result.warnings.length
    ? translate("status.warningsSuffix", { count: result.warnings.length, plural: result.warnings.length === 1 ? "" : "s" })
    : "";
  return translate("status.importedSessions", {
    count,
    source,
    plural: count === 1 ? "" : "s",
    skipped,
    warnings: warningSuffix,
  });
}

function reportError(error: unknown) {
  window.alert(error instanceof Error ? error.message : String(error));
}
