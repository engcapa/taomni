import { useEffect, useMemo, useRef, useState } from "react";
import {
  Terminal as TerminalIcon,
  Monitor,
  Folder,
  Wifi,
  ChevronRight,
  ChevronDown,
  FolderOpen,
  Play,
  Edit3,
  Copy,
  Trash2,
  Plus,
  FolderPlus,
  Upload,
  Download,
  FileText,
  Share2,
  Star,
} from "lucide-react";
import { useSessionStore } from "../../stores/sessionStore";
import { useAppStore } from "../../stores/appStore";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { FolderNameDialog } from "./FolderNameDialog";
import type { SessionConfig, SessionGroup } from "../../lib/ipc";
import {
  importExternalBashSessions,
  importPuttySessions,
  importWslSessions,
  scanLocalSessionFiles,
} from "../../lib/ipc";
import {
  startCustomDrag,
  useCustomDropTarget,
  type CustomDragData,
} from "../../lib/customDnD";
import {
  parseCsvSessions,
  parseItermDynamicProfiles,
  parseMobaXtermSessions,
  parseNewMobSessions,
  parseSecureCrtSessions,
  parseTabbySessions,
  parseTerminalAppProfiles,
  parseWindTermSessions,
  parseXmlConnectionSessions,
  parseXshellSessions,
  createSessionImportResult,
  serializeCsvSessions,
  serializeMobaXtermSessions,
  serializeNewMobSessions,
  type SessionExportResult,
  type SessionImportOptions,
  type SessionImportResult,
} from "../../lib/sessionImportExport";
import { parseOpenSshConfig } from "../../lib/quickConnect";
import { openBinaryFile, openTextFile, openTextFileWithName, downloadTextFile } from "../../lib/fileHelpers";
import { serializeHtmlSessions } from "../../lib/sessionExportHtml";
import {
  SESSION_ROOT_LABEL,
  ancestorGroupPaths,
  collectFolderPaths,
  folderOptionLabel,
  groupPathContains,
  leafGroupName,
  normalizeGroupPath,
  parentGroupPath,
  toStoredGroupPath,
} from "../../lib/sessionPaths";
import { SessionImportPreview } from "../session/SessionImportPreview";

const SESSION_DRAG_MIME = "newmob/session";

interface SessionDragPayload {
  sessionId: string;
}

interface SessionTreeProps {
  onNewSession?: (groupPath?: string | null) => void;
  onConnectSession?: (session: SessionConfig) => void;
  onEditSession?: (session: SessionConfig) => void;
}

interface FolderNode {
  name: string;
  path: string | null;
  folders: FolderNode[];
  sessions: SessionConfig[];
}

type TextSessionParser = (text: string, options?: SessionImportOptions) => SessionImportResult;

export function SessionTree({ onNewSession, onConnectSession, onEditSession }: SessionTreeProps) {
  const {
    sessions,
    groups,
    searchQuery,
    selectedSessionId,
    loadSessions,
    removeSession,
    duplicateSession,
    moveSessionToGroup,
    createFolderPath,
    renameFolderPath,
    deleteFolderPath,
    importSessions,
    setSelectedSession,
    loading,
  } = useSessionStore();
  const { setStatusMessage } = useAppStore();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ root: true });
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const [folderDialog, setFolderDialog] = useState<
    | { mode: "create"; parentPath: string | null }
    | { mode: "rename"; parentPath: string | null; folderPath: string; initialName: string }
    | null
  >(null);
  const [pendingImport, setPendingImport] = useState<{
    result: SessionImportResult;
    folderPath: string | null;
    source: string;
  } | null>(null);
  const ctx = useContextMenu();

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const filteredSessions = useMemo(
    () => filterSessions(sessions, searchQuery),
    [sessions, searchQuery],
  );
  const tree = useMemo(
    () => buildSessionTree(filteredSessions, searchQuery ? [] : groups),
    [filteredSessions, groups, searchQuery],
  );
  const folderPaths = useMemo(
    () => collectFolderPaths(sessions, groups),
    [sessions, groups],
  );

  const toggle = (key: string) =>
    setExpanded((e) => ({ ...e, [key]: !e[key] }));

  const expandPath = (path: string | null | undefined) => {
    setExpanded((state) => {
      const next: Record<string, boolean> = { ...state, root: true };
      for (const ancestor of ancestorGroupPaths(path)) {
        next[folderKey(ancestor)] = true;
      }
      return next;
    });
  };

  const handleDrop = (groupPath: string | null, sessionId: string) => {
    setDragOverGroup(null);
    if (!sessionId) return;
    void moveSessionToGroup(sessionId, groupPath);
    expandPath(groupPath);
  };

  const handleDragOver = (groupPath: string | null) => {
    setDragOverGroup(folderKey(groupPath));
  };

  const createFolder = (parentPath: string | null) => {
    setFolderDialog({ mode: "create", parentPath: normalizeGroupPath(parentPath) });
  };

  const handleCreateFolderSubmit = async (folderPath: string) => {
    const normalized = normalizeGroupPath(folderPath);
    if (!normalized) return;

    await createFolderPath(normalized);
    expandPath(normalized);
    setStatusMessage(`Created folder ${folderOptionLabel(normalized)}`);
  };

  const renameFolder = (folderPath: string) => {
    const normalized = normalizeGroupPath(folderPath);
    if (!normalized) return;
    setFolderDialog({
      mode: "rename",
      parentPath: parentGroupPath(normalized),
      folderPath: normalized,
      initialName: leafGroupName(normalized),
    });
  };

  const handleRenameFolderSubmit = async (sourcePath: string, targetPath: string) => {
    const oldNormalized = normalizeGroupPath(sourcePath);
    const newNormalized = normalizeGroupPath(targetPath);
    if (!oldNormalized || !newNormalized || oldNormalized === newNormalized) return;
    if (groupPathContains(oldNormalized, newNormalized)) {
      window.alert("A folder cannot be moved inside itself.");
      return;
    }

    await renameFolderPath(oldNormalized, newNormalized);
    expandPath(newNormalized);
    setStatusMessage(`Renamed folder to ${folderOptionLabel(newNormalized)}`);
  };

  const handleFolderDialogSubmit = async (folderPath: string) => {
    const dialog = folderDialog;
    setFolderDialog(null);
    if (!dialog) return;
    if (dialog.mode === "create") {
      await handleCreateFolderSubmit(folderPath);
    } else {
      await handleRenameFolderSubmit(dialog.folderPath, folderPath);
    }
  };

  const deleteFolder = async (folderPath: string) => {
    const affected = sessionsInFolder(sessions, folderPath);
    const suffix = affected.length > 0
      ? ` and ${affected.length} session${affected.length === 1 ? "" : "s"} inside it`
      : "";
    if (!window.confirm(`Delete folder "${folderOptionLabel(folderPath)}"${suffix}?`)) return;

    await deleteFolderPath(folderPath);
    setStatusMessage(`Deleted folder ${folderOptionLabel(folderPath)}`);
  };

  const exportFolder = (folderPath: string | null) => {
    const folderSessions = sessionsInFolder(sessions, folderPath);
    const label = folderOptionLabel(folderPath);
    const result = serializeNewMobSessions(folderSessions, folderPath);
    downloadTextFile(result.filename, result.text, result.mimeType);
    reportExportResult("NewMob", result, folderSessions.length, label);
  };

  const exportMobaFolder = (folderPath: string | null) => {
    const folderSessions = sessionsInFolder(sessions, folderPath);
    const label = folderOptionLabel(folderPath);
    const result = serializeMobaXtermSessions(folderSessions, folderPath);
    downloadTextFile(result.filename, result.text, result.mimeType);
    reportExportResult("MobaXterm", result, folderSessions.length - result.skipped, label);
  };

  const exportCsvFolder = (folderPath: string | null) => {
    const folderSessions = sessionsInFolder(sessions, folderPath);
    const label = folderOptionLabel(folderPath);
    const result = serializeCsvSessions(folderSessions, folderPath);
    downloadTextFile(result.filename, result.text, result.mimeType);
    reportExportResult("CSV", result, folderSessions.length - result.skipped, label);
  };

  const generateHtml = (folderPath: string | null) => {
    const folderSessions = sessionsInFolder(sessions, folderPath);
    const label = folderOptionLabel(folderPath);
    const result = serializeHtmlSessions(folderSessions, folderPath);
    downloadTextFile(result.filename, result.text, result.mimeType);
    reportExportResult("HTML", result, folderSessions.length, label);
  };

  const importJson = (folderPath: string | null) => {
    openTextFile(".json,.newmob-sessions.json,application/json").then((text) => {
      if (!text) return;
      const result = parseNewMobSessions(text, { targetFolder: folderPath, existingSessions: sessions });
      queueImportPreview(result, folderPath, "NewMob");
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importMoba = (folderPath: string | null) => {
    openBinaryFile(".mxtsessions,.moba,text/plain,application/octet-stream").then((bytes) => {
      if (!bytes) return;
      const result = parseMobaXtermSessions(bytes, { targetFolder: folderPath, existingSessions: sessions });
      queueImportPreview(result, folderPath, "MobaXterm");
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importCsv = (folderPath: string | null) => {
    openTextFile(".csv,text/csv").then((text) => {
      if (!text) return;
      const result = parseCsvSessions(text, { targetFolder: folderPath, existingSessions: sessions });
      queueImportPreview(result, folderPath, "CSV");
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const queueImportPreview = (
    result: SessionImportResult,
    folderPath: string | null,
    source: string,
  ) => {
    setPendingImport({ result, folderPath, source });
  };

  const confirmPendingImport = async () => {
    const pending = pendingImport;
    if (!pending) return;
    await applyImportResult(pending.result, pending.folderPath, pending.source, { alertWarnings: false });
    setPendingImport(null);
  };

  const applyImportResult = async (
    result: SessionImportResult,
    folderPath: string | null,
    source: string,
    options: { alertWarnings?: boolean } = {},
  ) => {
    if (result.sessions.length > 0) {
      await importSessions(result.sessions);
      expandPath(folderPath);
    }
    reportImportResult(source, result, folderPath, options.alertWarnings !== false);
  };

  const reportImportResult = (
    source: string,
    result: SessionImportResult,
    folderPath: string | null,
    alertWarnings = true,
  ) => {
    const target = folderOptionLabel(folderPath);
    const count = result.sessions.length;
    const skipped = result.skipped ? `, skipped ${result.skipped}` : "";
    const warningSuffix = result.warnings.length ? `, ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}` : "";
    setStatusMessage(`Imported ${count} ${source} session${count === 1 ? "" : "s"} into ${target}${skipped}${warningSuffix}`);
    if (alertWarnings) reportWarnings(result.warnings);
  };

  const reportExportResult = (
    format: string,
    result: SessionExportResult,
    count: number,
    label: string,
  ) => {
    const skipped = result.skipped ? `, skipped ${result.skipped}` : "";
    const warningSuffix = result.warnings.length ? `, ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}` : "";
    setStatusMessage(`Exported ${count} ${format} session${count === 1 ? "" : "s"} from ${label}${skipped}${warningSuffix}`);
    reportWarnings(result.warnings);
  };

  const reportWarnings = (warnings: string[]) => {
    if (warnings.length === 0) return;
    const shown = warnings.slice(0, 8);
    const more = warnings.length > shown.length ? `\n...and ${warnings.length - shown.length} more warning${warnings.length - shown.length === 1 ? "" : "s"}.` : "";
    window.alert(`${shown.join("\n")}${more}`);
  };

  const executeFolder = (folderPath: string | null) => {
    const folderSessions = sessionsInFolder(sessions, folderPath);
    for (const session of folderSessions) {
      onConnectSession?.(session);
    }
    setStatusMessage(`Started ${folderSessions.length} session${folderSessions.length === 1 ? "" : "s"} from ${folderOptionLabel(folderPath)}`);
  };

  const mergeImportResults = (results: SessionImportResult[]): SessionImportResult =>
    createSessionImportResult(results.flatMap((result) => result.sessions), {
      existingSessions: sessions,
      warnings: results.flatMap((result) => result.warnings),
      skipped: results.reduce((sum, result) => sum + result.skipped, 0),
    });

  const retargetImportedSessions = (
    imported: readonly SessionConfig[],
    folderPath: string | null,
    defaultSubfolder: string | null,
  ): SessionConfig[] => imported.map((session) => {
    const target = normalizeGroupPath(folderPath);
    const importedFolder = normalizeGroupPath(session.group_path) ?? normalizeGroupPath(defaultSubfolder);
    const groupPath = target && importedFolder
      ? `${target} / ${importedFolder}`
      : target ?? importedFolder;
    return { ...session, group_path: toStoredGroupPath(groupPath) };
  });

  const queueSessionListImport = (
    imported: readonly SessionConfig[],
    folderPath: string | null,
    source: string,
    defaultSubfolder: string | null,
  ) => {
    const result = createSessionImportResult(
      retargetImportedSessions(imported, folderPath, defaultSubfolder),
      { existingSessions: sessions },
    );
    queueImportPreview(result, folderPath, source);
  };

  const importBackendSessions = (
    folderPath: string | null,
    source: string,
    load: () => Promise<SessionConfig[]>,
    defaultSubfolder: string,
  ) => {
    load().then((imported) => {
      if (imported.length === 0) {
        setStatusMessage(`No ${source} sessions were found on this system.`);
        return;
      }
      queueSessionListImport(imported, folderPath, source, defaultSubfolder);
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importTextSessions = (
    folderPath: string | null,
    source: string,
    accept: string,
    parser: TextSessionParser,
  ) => {
    openTextFileWithName(accept).then((file) => {
      if (!file) return;
      const result = parser(file.text, {
        targetFolder: folderPath,
        existingSessions: sessions,
        sourcePath: file.name,
      });
      queueImportPreview(result, folderPath, source);
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importScannedTextSessions = (
    folderPath: string | null,
    scanKey: string,
    source: string,
    parser: TextSessionParser,
  ) => {
    scanLocalSessionFiles(scanKey).then((files) => {
      if (files.length === 0) {
        setStatusMessage(`No ${source} local configuration files were found.`);
        return;
      }
      const result = mergeImportResults(files.map((file) =>
        parser(file.text, {
          targetFolder: folderPath,
          sourcePath: file.relativePath || file.path,
        }),
      ));
      queueImportPreview(result, folderPath, `${source} local config`);
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importOpenSshText = (folderPath: string | null, source: string, defaultSubfolder: string) => {
    openTextFileWithName(".ssh_config,.conf,.config,.txt,text/plain").then((file) => {
      if (!file) return;
      const imported = parseOpenSshConfig(file.text).map((session) => ({
        ...session,
        group_path: defaultSubfolder,
      }));
      queueSessionListImport(imported, folderPath, source, defaultSubfolder);
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importScannedOpenSsh = (folderPath: string | null, scanKey: string, source: string, defaultSubfolder: string) => {
    scanLocalSessionFiles(scanKey).then((files) => {
      if (files.length === 0) {
        setStatusMessage(`No ${source} exported SSH config files were found.`);
        return;
      }
      const imported = files.flatMap((file) => parseOpenSshConfig(file.text)).map((session) => ({
        ...session,
        group_path: defaultSubfolder,
      }));
      queueSessionListImport(imported, folderPath, `${source} local export`, defaultSubfolder);
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const showTermiusGuide = () => {
    window.alert([
      "Termius local databases are encrypted by the OS keychain and cannot be imported directly.",
      "",
      "Run this in your terminal, then import the generated OpenSSH config:",
      "termius export-ssh-config",
    ].join("\n"));
  };

  const unavailable = (label: string) => {
    setStatusMessage(`${label} is not implemented yet`);
  };

  const folderContextMenu = (e: React.MouseEvent, folderPath: string | null) => {
    const normalized = normalizeGroupPath(folderPath);
    const isRoot = !normalized;
    const folderSessions = sessionsInFolder(sessions, folderPath);
    const importChildren: MenuItem[] = [
      {
        label: "Import MobaXterm sessions",
        icon: <Upload className="w-3 h-3" />,
        onClick: () => importMoba(folderPath),
      },
      {
        label: "Import WSL sessions",
        icon: <TerminalIcon className="w-3 h-3" />,
        onClick: () => importBackendSessions(folderPath, "WSL", importWslSessions, "Imported / WSL"),
      },
      {
        label: "Import External Bash sessions",
        icon: <TerminalIcon className="w-3 h-3" />,
        onClick: () => importBackendSessions(folderPath, "External Bash", importExternalBashSessions, "Imported / External Bash"),
      },
      {
        label: "Import PuTTY sessions",
        icon: <TerminalIcon className="w-3 h-3" />,
        onClick: () => importBackendSessions(folderPath, "PuTTY", importPuttySessions, "Imported / PuTTY"),
      },
      { label: "", separator: true },
      {
        label: "Import Xshell sessions",
        icon: <Upload className="w-3 h-3" />,
        children: [
          {
            label: "From .xsh file",
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importTextSessions(folderPath, "Xshell", ".xsh,text/plain", parseXshellSessions),
          },
          {
            label: "From local Xshell config",
            icon: <FolderOpen className="w-3 h-3" />,
            onClick: () => importScannedTextSessions(folderPath, "xshell", "Xshell", parseXshellSessions),
          },
        ],
      },
      {
        label: "Import Tabby sessions",
        icon: <Upload className="w-3 h-3" />,
        children: [
          {
            label: "From config.yaml",
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importTextSessions(folderPath, "Tabby", ".yaml,.yml,text/yaml,text/plain", parseTabbySessions),
          },
          {
            label: "From local Tabby config",
            icon: <FolderOpen className="w-3 h-3" />,
            onClick: () => importScannedTextSessions(folderPath, "tabby", "Tabby", parseTabbySessions),
          },
        ],
      },
      {
        label: "Import WindTerm sessions",
        icon: <Upload className="w-3 h-3" />,
        children: [
          {
            label: "From user.sessions file",
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importTextSessions(folderPath, "WindTerm", ".sessions,.json,user.sessions,application/json,text/plain", parseWindTermSessions),
          },
          {
            label: "From local WindTerm config",
            icon: <FolderOpen className="w-3 h-3" />,
            onClick: () => importScannedTextSessions(folderPath, "windterm", "WindTerm", parseWindTermSessions),
          },
        ],
      },
      { label: "", separator: true },
      {
        label: "Import iTerm2 profiles",
        icon: <Upload className="w-3 h-3" />,
        children: [
          {
            label: "From JSON/plist file",
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importTextSessions(folderPath, "iTerm2", ".json,.plist,application/json,text/xml", parseItermDynamicProfiles),
          },
          {
            label: "From local iTerm2 DynamicProfiles",
            icon: <FolderOpen className="w-3 h-3" />,
            onClick: () => importScannedTextSessions(folderPath, "iterm2", "iTerm2", parseItermDynamicProfiles),
          },
        ],
      },
      {
        label: "Import Terminal.app profiles",
        icon: <Upload className="w-3 h-3" />,
        children: [
          {
            label: "From .terminal/plist file",
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importTextSessions(folderPath, "Terminal.app", ".terminal,.plist,text/xml", parseTerminalAppProfiles),
          },
          {
            label: "From local Terminal.app preferences",
            icon: <FolderOpen className="w-3 h-3" />,
            onClick: () => importScannedTextSessions(folderPath, "terminal", "Terminal.app", parseTerminalAppProfiles),
          },
        ],
      },
      {
        label: "Import Termius sessions",
        icon: <Upload className="w-3 h-3" />,
        children: [
          {
            label: "Show export guide",
            icon: <FileText className="w-3 h-3" />,
            onClick: showTermiusGuide,
          },
          {
            label: "From exported OpenSSH config",
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importOpenSshText(folderPath, "Termius", "Imported / Termius"),
          },
          {
            label: "Detect local Termius export",
            icon: <FolderOpen className="w-3 h-3" />,
            onClick: () => importScannedOpenSsh(folderPath, "termius", "Termius", "Imported / Termius"),
          },
        ],
      },
      { label: "", separator: true },
      {
        label: "Import PuTTYCM sessions",
        icon: <Upload className="w-3 h-3" />,
        onClick: () => importTextSessions(folderPath, "PuTTYCM", ".xml,text/xml,application/xml", parseXmlConnectionSessions),
      },
      {
        label: "Import SuperPuTTY sessions",
        icon: <Upload className="w-3 h-3" />,
        onClick: () => importTextSessions(folderPath, "SuperPuTTY", ".xml,.settings,text/xml,application/xml", parseXmlConnectionSessions),
      },
      {
        label: "Import MRemote sessions",
        icon: <Upload className="w-3 h-3" />,
        children: [
          {
            label: "From XML file",
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importTextSessions(folderPath, "mRemote", ".xml,text/xml,application/xml", parseXmlConnectionSessions),
          },
          {
            label: "From local mRemoteNG config",
            icon: <FolderOpen className="w-3 h-3" />,
            onClick: () => importScannedTextSessions(folderPath, "mremote", "mRemote", parseXmlConnectionSessions),
          },
        ],
      },
      {
        label: "Import Exceed sessions",
        icon: <Upload className="w-3 h-3" />,
        onClick: () => importTextSessions(folderPath, "Exceed", ".xml,.xs,text/xml,application/xml,text/plain", parseXmlConnectionSessions),
      },
      {
        label: "Import SCRT sessions",
        icon: <Upload className="w-3 h-3" />,
        children: [
          {
            label: "From SecureCRT .ini file",
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importTextSessions(folderPath, "SecureCRT", ".ini,text/plain", parseSecureCrtSessions),
          },
          {
            label: "From local SecureCRT config",
            icon: <FolderOpen className="w-3 h-3" />,
            onClick: () => importScannedTextSessions(folderPath, "securecrt", "SecureCRT", parseSecureCrtSessions),
          },
        ],
      },
      {
        label: "Import RDM sessions",
        icon: <Upload className="w-3 h-3" />,
        onClick: () => importTextSessions(folderPath, "Remote Desktop Manager", ".rdm,.xml,text/xml,application/xml", parseXmlConnectionSessions),
      },
      { label: "", separator: true },
      {
        label: "Import sessions from a CSV file",
        icon: <FileText className="w-3 h-3" />,
        onClick: () => importCsv(folderPath),
      },
    ];

    ctx.show(e, [
      { label: "New session", icon: <Plus className="w-3 h-3" />, onClick: () => onNewSession?.(toStoredGroupPath(folderPath)) },
      { label: "New folder", icon: <FolderPlus className="w-3 h-3" />, onClick: () => createFolder(folderPath) },
      { label: "Edit folder", icon: <Edit3 className="w-3 h-3" />, disabled: isRoot, onClick: () => { if (normalized) renameFolder(normalized); } },
      { label: "Delete folder", icon: <Trash2 className="w-3 h-3" />, danger: true, disabled: isRoot, onClick: () => normalized && void deleteFolder(normalized) },
      { label: "Create a desktop shortcut", icon: <Star className="w-3 h-3" />, onClick: () => unavailable("Create a desktop shortcut") },
      { label: "", separator: true },
      { label: "Import NewMob sessions", icon: <Upload className="w-3 h-3" />, onClick: () => importJson(folderPath) },
      { label: "Export NewMob sessions", icon: <Download className="w-3 h-3" />, disabled: folderSessions.length === 0, onClick: () => exportFolder(folderPath) },
      { label: "Export MobaXterm sessions", icon: <Download className="w-3 h-3" />, disabled: folderSessions.length === 0, onClick: () => exportMobaFolder(folderPath) },
      { label: "Export sessions as CSV", icon: <FileText className="w-3 h-3" />, disabled: folderSessions.length === 0, onClick: () => exportCsvFolder(folderPath) },
      { label: "Import sessions from third-party programs", icon: <Upload className="w-3 h-3" />, children: importChildren },
      { label: "Generate HTML web page", icon: <FileText className="w-3 h-3" />, disabled: folderSessions.length === 0, onClick: () => generateHtml(folderPath) },
      { label: "", separator: true },
      { label: "Execute all sessions from this folder", icon: <Play className="w-3 h-3" />, disabled: folderSessions.length === 0 || !onConnectSession, onClick: () => executeFolder(folderPath) },
      { label: "", separator: true },
      { label: "Share these sessions with my team", icon: <Share2 className="w-3 h-3" />, onClick: () => unavailable("Share these sessions with my team") },
    ]);
  };

  const sessionContextMenu = (e: React.MouseEvent, session: SessionConfig) => {
    setSelectedSession(session.id);
    const moveChildren: MenuItem[] = [
      { label: SESSION_ROOT_LABEL, icon: <FolderOpen className="w-3 h-3" />, onClick: () => void moveSessionToGroup(session.id, null) },
      ...folderPaths.map((path) => ({
        label: folderOptionLabel(path),
        icon: <Folder className="w-3 h-3" />,
        onClick: () => {
          void moveSessionToGroup(session.id, path);
          expandPath(path);
        },
      })),
    ];

    ctx.show(e, [
      { label: "Connect", icon: <Play className="w-3 h-3" />, onClick: () => onConnectSession?.(session), disabled: !onConnectSession },
      { label: "Edit...", icon: <Edit3 className="w-3 h-3" />, onClick: () => onEditSession?.(session), disabled: !onEditSession },
      { label: "Duplicate", icon: <Copy className="w-3 h-3" />, onClick: () => void duplicateSession(session.id) },
      { label: "Move to folder", icon: <Folder className="w-3 h-3" />, children: moveChildren },
      { label: "", separator: true },
      { label: "Delete", icon: <Trash2 className="w-3 h-3" />, danger: true, onClick: () => void removeSession(session.id) },
    ]);
  };

  return (
    <>
      {folderDialog && (
        <FolderNameDialog
          parentPath={folderDialog.parentPath}
          initialName={folderDialog.mode === "rename" ? folderDialog.initialName : "New folder"}
          title={folderDialog.mode === "rename" ? "Edit folder" : "New folder"}
          onCancel={() => setFolderDialog(null)}
          onSubmit={handleFolderDialogSubmit}
        />
      )}
      {pendingImport && (
        <SessionImportPreview
          source={pendingImport.source}
          result={pendingImport.result}
          targetFolder={pendingImport.folderPath}
          onCancel={() => setPendingImport(null)}
          onConfirm={() => void confirmPendingImport()}
        />
      )}
      <div
        data-testid="session-tree"
        className="flex-1 moba-scroll-y"
        onContextMenu={(event) => folderContextMenu(event, null)}
      >
        {ctx.render}
        <TreeFolder
        node={tree}
        count={countNodeSessions(tree)}
        open={expanded.root !== false}
        onToggle={() => toggle("root")}
        onContextMenu={(event) => folderContextMenu(event, null)}
        onDropSession={(sessionId) => handleDrop(null, sessionId)}
        onDragOverFolder={() => handleDragOver(null)}
        onDragLeave={() => setDragOverGroup(null)}
        dragOver={dragOverGroup === "root"}
      >
        <FolderContents
          node={tree}
          expanded={expanded}
          searchQuery={searchQuery}
          selectedSessionId={selectedSessionId}
          dragOverGroup={dragOverGroup}
          onToggle={toggle}
          onFolderContextMenu={folderContextMenu}
          onSessionContextMenu={sessionContextMenu}
          onDropSession={handleDrop}
          onDragOverFolder={handleDragOver}
          onDragLeave={() => setDragOverGroup(null)}
          onSelectSession={setSelectedSession}
          onConnectSession={onConnectSession}
        />
        {filteredSessions.length === 0 && !loading && (
          <div className="pl-6 py-2 text-[var(--moba-text-muted)]" style={{ fontSize: "calc(var(--moba-ui-font-size) - 1px)" }}>
            {searchQuery ? "No matching sessions." : "No sessions yet. Right-click User sessions to create one."}
          </div>
        )}
      </TreeFolder>

    </div>
    </>
  );
}

function FolderContents({
  node,
  expanded,
  searchQuery,
  selectedSessionId,
  dragOverGroup,
  onToggle,
  onFolderContextMenu,
  onSessionContextMenu,
  onDropSession,
  onDragOverFolder,
  onDragLeave,
  onSelectSession,
  onConnectSession,
}: {
  node: FolderNode;
  expanded: Record<string, boolean>;
  searchQuery: string;
  selectedSessionId: string | null;
  dragOverGroup: string | null;
  onToggle: (key: string) => void;
  onFolderContextMenu: (event: React.MouseEvent, path: string | null) => void;
  onSessionContextMenu: (event: React.MouseEvent, session: SessionConfig) => void;
  onDropSession: (groupPath: string | null, sessionId: string) => void;
  onDragOverFolder: (groupPath: string | null) => void;
  onDragLeave: () => void;
  onSelectSession: (id: string | null) => void;
  onConnectSession?: (session: SessionConfig) => void;
}) {
  return (
    <>
      {node.folders.map((folder) => {
        const key = folderKey(folder.path);
        const isOpen = searchQuery ? true : !!expanded[key];

        return (
          <TreeFolder
            key={key}
            node={folder}
            count={countNodeSessions(folder)}
            open={isOpen}
            onToggle={() => onToggle(key)}
            onContextMenu={(event) => onFolderContextMenu(event, folder.path)}
            onDropSession={(sessionId) => onDropSession(folder.path, sessionId)}
            onDragOverFolder={() => onDragOverFolder(folder.path)}
            onDragLeave={onDragLeave}
            dragOver={dragOverGroup === key}
          >
            <FolderContents
              node={folder}
              expanded={expanded}
              searchQuery={searchQuery}
              selectedSessionId={selectedSessionId}
              dragOverGroup={dragOverGroup}
              onToggle={onToggle}
              onFolderContextMenu={onFolderContextMenu}
              onSessionContextMenu={onSessionContextMenu}
              onDropSession={onDropSession}
              onDragOverFolder={onDragOverFolder}
              onDragLeave={onDragLeave}
              onSelectSession={onSelectSession}
              onConnectSession={onConnectSession}
            />
          </TreeFolder>
        );
      })}

      {node.sessions.map((session) => (
        <SessionItem
          key={session.id}
          session={session}
          selected={selectedSessionId === session.id}
          onClick={() => onSelectSession(session.id)}
          onDoubleClick={() => onConnectSession?.(session)}
          onContextMenu={(event) => onSessionContextMenu(event, session)}
        />
      ))}
    </>
  );
}

function TreeFolder({
  node,
  count,
  open,
  onToggle,
  children,
  onContextMenu,
  onDropSession,
  onDragOverFolder,
  onDragLeave,
  dragOver,
}: {
  node: FolderNode;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
  onContextMenu?: (event: React.MouseEvent) => void;
  onDropSession?: (sessionId: string) => void;
  onDragOverFolder?: () => void;
  onDragLeave?: () => void;
  dragOver?: boolean;
}) {
  const isRoot = node.path === null;
  const hasChildren = node.folders.length > 0 || node.sessions.length > 0;
  const headerRef = useRef<HTMLDivElement>(null);

  useCustomDropTarget<HTMLDivElement>(headerRef, {
    accepts: (data: CustomDragData) =>
      data.mime === SESSION_DRAG_MIME && !!onDropSession,
    onDragEnter: () => onDragOverFolder?.(),
    onDragOver: () => onDragOverFolder?.(),
    onDragLeave: () => onDragLeave?.(),
    onDrop: (detail) => {
      const payload = detail.data.payload as SessionDragPayload | null;
      if (payload?.sessionId) onDropSession?.(payload.sessionId);
    },
  });

  return (
    <div>
      <div
        ref={headerRef}
        className="moba-tree-row"
        data-drag-over={dragOver}
        style={dragOver ? { background: "var(--moba-selected)" } : undefined}
        onClick={onToggle}
        onContextMenu={onContextMenu}
      >
        {open ? (
          <ChevronDown className="w-3 h-3 text-slate-500" />
        ) : (
          <ChevronRight className="w-3 h-3 text-slate-500" />
        )}
        {open || isRoot ? (
          <FolderOpen className="w-3.5 h-3.5 text-amber-600" />
        ) : (
          <Folder className="w-3.5 h-3.5 text-amber-600" />
        )}
        <span className="flex-1 font-medium truncate">{node.name}</span>
        {count !== undefined && hasChildren && (
          <span className="text-slate-500" style={{ fontSize: "calc(var(--moba-ui-font-size) - 2px)" }}>({count})</span>
        )}
      </div>
      {open && <div className="pl-4">{children}</div>}
    </div>
  );
}

function SessionItem({
  session,
  selected,
  onClick,
  onDoubleClick,
  onContextMenu,
}: {
  session: SessionConfig;
  selected: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const icon = sessionIcon(session.session_type);
  const ref = useRef<HTMLDivElement>(null);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = ref.current;
    if (!el) return;
    startCustomDrag({
      event: e,
      data: {
        mime: SESSION_DRAG_MIME,
        payload: { sessionId: session.id } satisfies SessionDragPayload,
      },
      ghostText: session.name,
      ghostElement: el,
    });
  };

  return (
    <div
      ref={ref}
      data-testid="session-tree-item"
      data-session-name={session.name}
      data-session-type={session.session_type}
      className="moba-tree-row group"
      data-selected={selected}
      style={selected ? { background: "var(--moba-selected)" } : undefined}
      onPointerDown={handlePointerDown}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <span className="w-3" />
      {icon}
      <span className="flex-1 truncate">
        {session.name}
        {session.username && session.host && (
          <span className="text-[var(--moba-text-muted)]">
            {" "}({session.username}@{session.host})
          </span>
        )}
      </span>
      <span
        className="px-1 rounded"
        style={{ fontSize: "calc(var(--moba-ui-font-size) - 2px)", background: "#e1ecfa", color: "#1e3a5f" }}
      >
        {session.session_type}
      </span>
    </div>
  );
}

function sessionIcon(type: string) {
  switch (type) {
    case "SSH":
      return <TerminalIcon className="w-3.5 h-3.5" style={{ color: "#2b5d8b" }} />;
    case "RDP":
      return <Monitor className="w-3.5 h-3.5" style={{ color: "#a04b9c" }} />;
    case "VNC":
      return <Monitor className="w-3.5 h-3.5" style={{ color: "#c97a23" }} />;
    case "SFTP":
    case "FTP":
      return <Folder className="w-3.5 h-3.5" style={{ color: "#3b7ac2" }} />;
    case "Serial":
      return <Wifi className="w-3.5 h-3.5" style={{ color: "#236a98" }} />;
    case "LocalShell":
      return <TerminalIcon className="w-3.5 h-3.5" style={{ color: "#62d36f" }} />;
    case "File":
      return <FileText className="w-3.5 h-3.5" style={{ color: "var(--moba-text-muted)" }} />;
    default:
      return <TerminalIcon className="w-3.5 h-3.5" style={{ color: "#2b5d8b" }} />;
  }
}

function buildSessionTree(sessions: SessionConfig[], groups: SessionGroup[]): FolderNode {
  const root: FolderNode = {
    name: SESSION_ROOT_LABEL,
    path: null,
    folders: [],
    sessions: [],
  };

  const nodes = new Map<string, FolderNode>();

  const ensureFolder = (path: string): FolderNode => {
    const normalized = normalizeGroupPath(path);
    if (!normalized) return root;
    const existing = nodes.get(normalized);
    if (existing) return existing;

    const parentPath = parentGroupPath(normalized);
    const parent = parentPath ? ensureFolder(parentPath) : root;
    const node: FolderNode = {
      name: leafGroupName(normalized),
      path: normalized,
      folders: [],
      sessions: [],
    };
    nodes.set(normalized, node);
    parent.folders.push(node);
    return node;
  };

  for (const path of collectFolderPaths(sessions, groups)) {
    ensureFolder(path);
  }

  for (const session of sessions) {
    const path = normalizeGroupPath(session.group_path);
    if (path) ensureFolder(path).sessions.push(session);
    else root.sessions.push(session);
  }

  sortFolder(root);
  return root;
}

function sortFolder(node: FolderNode) {
  node.folders.sort((a, b) => a.name.localeCompare(b.name));
  node.sessions.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  for (const folder of node.folders) sortFolder(folder);
}

function countNodeSessions(node: FolderNode): number {
  return node.sessions.length + node.folders.reduce((sum, folder) => sum + countNodeSessions(folder), 0);
}

function folderKey(path: string | null | undefined): string {
  return normalizeGroupPath(path) ?? "root";
}

function sessionsInFolder(sessions: SessionConfig[], folderPath: string | null | undefined): SessionConfig[] {
  const normalized = normalizeGroupPath(folderPath);
  if (!normalized) return sessions;
  return sessions.filter((session) => groupPathContains(normalized, session.group_path));
}

function filterSessions(sessions: SessionConfig[], query: string): SessionConfig[] {
  const q = query.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter((session) => {
    const haystack = [
      session.name,
      session.session_type,
      folderOptionLabel(session.group_path),
      session.host,
      session.username ?? "",
    ].join(" ").toLowerCase();
    return haystack.includes(q);
  });
}
