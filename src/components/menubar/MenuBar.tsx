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

interface MenuBarProps {
  activeTabClosable: boolean;
  onCommand: (command: RibbonCommand | "close-active" | "reload-sessions") => void;
}

export function MenuBar({ activeTabClosable, onCommand }: MenuBarProps) {
  const ctx = useContextMenu();
  const { sessions, importSessions } = useSessionStore();
  const { setStatusMessage } = useAppStore();
  const [pendingImport, setPendingImport] = useState<{
    result: SessionImportResult;
    source: string;
  } | null>(null);
  const items = [
    "Terminal", "Sessions", "View", "X server", "Tools", "Settings", "Macros", "Help",
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
    const skipped = result.skipped ? `, skipped ${result.skipped}` : "";
    const warningSuffix = result.warnings.length ? `, ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}` : "";
    setStatusMessage(`Exported ${count} ${format} session${count === 1 ? "" : "s"} from User sessions${skipped}${warningSuffix}`);
    if (result.warnings.length) {
      window.alert(result.warnings.slice(0, 8).join("\n"));
    }
  };

  const exportJson = () => exportResult("NewMob", serializeNewMobSessions(sessions, null));
  const exportMoba = () => exportResult("MobaXterm", serializeMobaXtermSessions(sessions, null));
  const exportCsv = () => exportResult("CSV", serializeCsvSessions(sessions, null));
  const exportHtml = () => exportResult("HTML", serializeHtmlSessions(sessions, null));

  const openMenu = (event: React.MouseEvent<HTMLButtonElement>, menu: string) => {
    event.preventDefault();
    event.stopPropagation();

    const rect = event.currentTarget.getBoundingClientRect();
    const showMenu = (menuItems: MenuItem[]) => ctx.showAt(rect.left, rect.bottom, menuItems);

    if (menu === "Terminal") {
      showMenu([
        { label: "New local terminal", icon: <TerminalIcon className="w-3 h-3" />, onClick: () => onCommand("new-terminal") },
        { label: "New remote session…", icon: <Plus className="w-3 h-3" />, onClick: () => onCommand("new-session") },
        { label: "", separator: true, onClick: () => {} },
        { label: "Close active tab", icon: <X className="w-3 h-3" />, onClick: () => onCommand("close-active"), disabled: !activeTabClosable },
      ]);
      return;
    }

    if (menu === "Sessions") {
      showMenu([
        { label: "New session…", icon: <Plus className="w-3 h-3" />, onClick: () => onCommand("new-session") },
        { label: "Show sessions", icon: <FolderOpen className="w-3 h-3" />, onClick: () => onCommand("sessions") },
        { label: "Reload sessions", icon: <RefreshCw className="w-3 h-3" />, onClick: () => onCommand("reload-sessions") },
        { label: "", separator: true },
        {
          label: "Import sessions",
          testId: "menu-import-sessions",
          icon: <Upload className="w-3 h-3" />,
          children: [
            { label: "Import NewMob sessions", testId: "import-json", icon: <Upload className="w-3 h-3" />, onClick: importJson },
            { label: "Import MobaXterm sessions", testId: "import-mobaxterm", icon: <Upload className="w-3 h-3" />, onClick: importMoba },
            { label: "Import sessions from a CSV file", testId: "import-csv", icon: <FileText className="w-3 h-3" />, onClick: importCsv },
            { label: "Import OpenSSH config", testId: "import-openssh", icon: <TerminalIcon className="w-3 h-3" />, onClick: importOpenSsh },
          ],
        },
        {
          label: "Export sessions",
          testId: "menu-export-sessions",
          icon: <Download className="w-3 h-3" />,
          disabled: !hasSessions,
          children: [
            { label: "Export NewMob sessions", testId: "export-json", icon: <Download className="w-3 h-3" />, onClick: exportJson },
            { label: "Export MobaXterm sessions", testId: "export-mobaxterm", icon: <Download className="w-3 h-3" />, onClick: exportMoba },
            { label: "Export sessions as CSV", testId: "export-csv", icon: <FileText className="w-3 h-3" />, onClick: exportCsv },
            { label: "Generate HTML web page", testId: "export-html", icon: <FileText className="w-3 h-3" />, onClick: exportHtml },
          ],
        },
      ]);
      return;
    }

    if (menu === "View") {
      showMenu([
        { label: "Toggle sidebar", icon: <PanelLeft className="w-3 h-3" />, onClick: () => onCommand("view") },
        { label: "Toggle compact mode", icon: <PanelTopClose className="w-3 h-3" />, shortcut: "Ctrl+Shift+M", onClick: () => onCommand("toggle-compact") },
        { label: "Split active terminal", icon: <PanelLeft className="w-3 h-3" />, onClick: () => onCommand("split") },
      ]);
      return;
    }

    if (menu === "X server") {
      showMenu([
        { label: "Toggle X server status", onClick: () => onCommand("toggle-xserver") },
      ]);
      return;
    }

    if (menu === "Help") {
      showMenu([
        { label: "About NewMob", icon: <HelpCircle className="w-3 h-3" />, onClick: () => onCommand("help") },
      ]);
      return;
    }

    const command = menu.toLowerCase() as RibbonCommand;
    showMenu([
      { label: `Open ${menu}`, onClick: () => onCommand(command) },
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
      {items.map((m) => (
        <button
          key={m}
          data-testid={`menu-${m.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
          className="px-1 hover:bg-[var(--moba-hover)] rounded"
          onClick={(event) => openMenu(event, m)}
          onMouseEnter={(event) => {
            if (ctx.isOpen) openMenu(event, m);
          }}
          type="button"
        >
          <span className="underline-offset-2">
            <span className="underline">{m[0]}</span>
            {m.slice(1)}
          </span>
        </button>
      ))}
    </div>
  );
}

function importStatusMessage(source: string, result: SessionImportResult): string {
  const count = result.sessions.length;
  const skipped = result.skipped ? `, skipped ${result.skipped}` : "";
  const warningSuffix = result.warnings.length ? `, ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}` : "";
  return `Imported ${count} ${source} session${count === 1 ? "" : "s"} into User sessions${skipped}${warningSuffix}`;
}

function reportError(error: unknown) {
  window.alert(error instanceof Error ? error.message : String(error));
}
