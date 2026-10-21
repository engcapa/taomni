import { Database, Download, Edit3, FileText, FolderOpen, FolderPlus, Play, Plus, Share2, Star, Terminal as TerminalIcon, Trash2, Upload } from "lucide-react";
import type { SessionConfig } from "../../../lib/ipc";
import { importExternalBashSessions, importPuttySessions, importWslSessions } from "../../../lib/ipc";
import {
  parseExceedSessions,
  parseItermDynamicProfiles,
  parseSecureCrtSessions,
  parseTabbySessions,
  parseTerminalAppProfiles,
  parseWindTermSessions,
  parseXmlConnectionSessions,
  parseXshellSessions,
  parseZeroOmegaProxies,
} from "../../../lib/sessionImportExport";
import { normalizeGroupPath, toStoredGroupPath } from "../../../lib/sessionPaths";
import { type MenuItem } from "../../ContextMenu";
import type { createSessionExports } from "./createSessionExports";
import type { createSessionImportSources } from "./createSessionImportSources";
import { sessionsInFolder } from "./model";


export interface CreateFolderContextMenuContext {
  sessions: SessionConfig[];
  t: import("../../../lib/i18n").TranslateFn;
  importMoba: (folderPath: string | null) => void;
  importSources: ReturnType<typeof createSessionImportSources>;
  importCsv: (folderPath: string | null) => void;
  exports: ReturnType<typeof createSessionExports>;
  ctx: { show: (e: React.MouseEvent, items: MenuItem[]) => void; showAt: (x: number, y: number, items: MenuItem[], menuOptions?: import("../../ContextMenu").ContextMenuAppearance) => void; refreshItems: (items: MenuItem[]) => void; close: (reason?: import("../../ContextMenu").ContextMenuCloseReason) => void; render: import("react").JSX.Element | null; isOpen: boolean; };
  onNewSession: ((groupPath?: string | null) => void) | undefined;
  createFolder: (parentPath: string | null) => void;
  renameFolder: (folderPath: string) => void;
  deleteFolder: (folderPath: string) => void;
  importJson: (folderPath: string | null) => void;
  onConnectSession: ((session: SessionConfig) => void) | undefined;
  executeFolder: (folderPath: string | null) => void;
}

export function createFolderContextMenu(context: CreateFolderContextMenuContext) {
  const {
    sessions,
    t,
    importMoba,
    importSources,
    importCsv,
    exports,
    ctx,
    onNewSession,
    createFolder,
    renameFolder,
    deleteFolder,
    importJson,
    onConnectSession,
    executeFolder,
  } = context;

  const folderContextMenu = (e: React.MouseEvent, folderPath: string | null) => {
    const normalized = normalizeGroupPath(folderPath);
    const isRoot = !normalized;
    const folderSessions = sessionsInFolder(sessions, folderPath);
    const importChildren: MenuItem[] = [
      {
        label: t("sessionTree.contextImportMoba"),
        icon: <Upload className="w-3 h-3" />,
        onClick: () => importMoba(folderPath),
      },
      {
        label: t("sessionTree.contextImportWsl"),
        icon: <TerminalIcon className="w-3 h-3" />,
        onClick: () => importSources.importBackendSessions(folderPath, "WSL", importWslSessions, "Imported / WSL"),
      },
      {
        label: t("sessionTree.contextImportExternalBash"),
        icon: <TerminalIcon className="w-3 h-3" />,
        onClick: () => importSources.importBackendSessions(folderPath, "External Bash", importExternalBashSessions, "Imported / External Bash"),
      },
      {
        label: t("sessionTree.contextImportPutty"),
        icon: <TerminalIcon className="w-3 h-3" />,
        onClick: () => importSources.importBackendSessions(folderPath, "PuTTY", importPuttySessions, "Imported / PuTTY"),
      },
      { label: "", separator: true },
      {
        label: t("sessionTree.contextImportXshell"),
        icon: <Upload className="w-3 h-3" />,
        children: [
          {
            label: t("sessionTree.fromXshFile"),
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importSources.importXshellFile(folderPath),
          },
          {
            label: t("sessionTree.fromZipArchive"),
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importSources.importXshellZip(folderPath),
          },
          {
            label: t("sessionTree.fromLocalXshell"),
            icon: <FolderOpen className="w-3 h-3" />,
            onClick: () => importSources.importScannedTextSessions(folderPath, "xshell", "Xshell", parseXshellSessions),
          },
        ],
      },
      {
        label: t("sessionTree.contextImportTabby"),
        icon: <Upload className="w-3 h-3" />,
        children: [
          {
            label: t("sessionTree.fromConfigYaml"),
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importSources.importTextSessions(
              folderPath,
              "Tabby",
              ".yaml,.yml,text/yaml,text/plain",
              parseTabbySessions,
              importSources.tabbySecretImportOptions,
            ),
          },
          {
            label: t("sessionTree.fromLocalTabby"),
            icon: <FolderOpen className="w-3 h-3" />,
            onClick: () => importSources.importScannedTextSessions(
              folderPath,
              "tabby",
              "Tabby",
              parseTabbySessions,
              importSources.tabbySecretImportOptions,
            ),
          },
        ],
      },
      {
        label: t("sessionTree.contextImportWindTerm"),
        icon: <Upload className="w-3 h-3" />,
        children: [
          {
            label: t("sessionTree.fromUserSessions"),
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importSources.importTextSessions(folderPath, "WindTerm", ".sessions,.json,user.sessions,application/json,text/plain", parseWindTermSessions),
          },
          {
            label: t("sessionTree.fromLocalWindTerm"),
            icon: <FolderOpen className="w-3 h-3" />,
            onClick: () => importSources.importScannedTextSessions(folderPath, "windterm", "WindTerm", parseWindTermSessions),
          },
        ],
      },
      {
        label: t("sessionTree.contextImportNavicat"),
        icon: <Database className="w-3 h-3" />,
        children: [
          {
            label: t("sessionTree.fromNavicatNcxFile"),
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importSources.importNavicatFile(folderPath),
          },
          // Phase 2 TODO: local Navicat config scanning plus Pwd_2/navicat_cred recovery.
        ],
      },
      {
        label: t("sessionTree.contextImportDbeaver"),
        icon: <Database className="w-3 h-3" />,
        children: [
          {
            label: t("sessionTree.fromDbeaverDataSources"),
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importSources.importDbeaverFile(folderPath),
          },
          {
            label: t("sessionTree.fromLocalDbeaver"),
            icon: <FolderOpen className="w-3 h-3" />,
            onClick: () => importSources.importScannedDbeaverSessions(folderPath),
          },
        ],
      },
      { label: "", separator: true },
      {
        label: t("sessionTree.contextImportIterm2"),
        icon: <Upload className="w-3 h-3" />,
        children: [
          {
            label: t("sessionTree.fromJsonPlist"),
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importSources.importTextSessions(folderPath, "iTerm2", ".json,.plist,application/json,text/xml", parseItermDynamicProfiles),
          },
          {
            label: t("sessionTree.fromBinaryPlist"),
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importSources.importPlistSessions(folderPath, "iTerm2 plist", parseItermDynamicProfiles),
          },
          {
            label: t("sessionTree.fromLocalIterm2"),
            icon: <FolderOpen className="w-3 h-3" />,
            onClick: () => importSources.importScannedTextSessions(folderPath, "iterm2", "iTerm2", parseItermDynamicProfiles),
          },
        ],
      },
      {
        label: t("sessionTree.contextImportTerminalApp"),
        icon: <Upload className="w-3 h-3" />,
        children: [
          {
            label: t("sessionTree.fromTerminalPlist"),
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importSources.importTextSessions(folderPath, "Terminal.app", ".terminal,.plist,text/xml", parseTerminalAppProfiles),
          },
          {
            label: t("sessionTree.fromBinaryTerminalPlist"),
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importSources.importPlistSessions(folderPath, "Terminal.app plist", parseTerminalAppProfiles),
          },
          {
            label: t("sessionTree.fromLocalTerminalApp"),
            icon: <FolderOpen className="w-3 h-3" />,
            onClick: () => importSources.importScannedTextSessions(folderPath, "terminal", "Terminal.app", parseTerminalAppProfiles),
          },
        ],
      },
      {
        label: t("sessionTree.contextImportTermius"),
        icon: <Upload className="w-3 h-3" />,
        children: [
          {
            label: t("sessionTree.showExportGuide"),
            icon: <FileText className="w-3 h-3" />,
            onClick: importSources.showTermiusGuide,
          },
          {
            label: t("sessionTree.fromOpenSshConfig"),
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importSources.importOpenSshText(folderPath, "Termius", "Imported / Termius"),
          },
          {
            label: t("sessionTree.detectLocalTermius"),
            icon: <FolderOpen className="w-3 h-3" />,
            onClick: () => importSources.importScannedOpenSsh(folderPath, "termius", "Termius", "Imported / Termius"),
          },
        ],
      },
      { label: "", separator: true },
      {
        label: t("sessionTree.contextImportPuttyCm"),
        icon: <Upload className="w-3 h-3" />,
        onClick: () => importSources.importTextSessions(folderPath, "PuTTYCM", ".xml,text/xml,application/xml", parseXmlConnectionSessions),
      },
      {
        label: t("sessionTree.contextImportSuperPutty"),
        icon: <Upload className="w-3 h-3" />,
        onClick: () => importSources.importTextSessions(folderPath, "SuperPuTTY", ".xml,.settings,text/xml,application/xml", parseXmlConnectionSessions),
      },
      {
        label: t("sessionTree.contextImportMRemote"),
        icon: <Upload className="w-3 h-3" />,
        children: [
          {
            label: t("sessionTree.fromXmlFile"),
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importSources.importTextSessions(folderPath, "mRemote", ".xml,text/xml,application/xml", parseXmlConnectionSessions),
          },
          {
            label: t("sessionTree.fromLocalMRemoteNg"),
            icon: <FolderOpen className="w-3 h-3" />,
            onClick: () => importSources.importScannedTextSessions(folderPath, "mremote", "mRemote", parseXmlConnectionSessions),
          },
        ],
      },
      {
        label: t("sessionTree.contextImportExceed"),
        icon: <Upload className="w-3 h-3" />,
        onClick: () => importSources.importTextSessions(folderPath, "Exceed", ".xml,.xs,.txt,text/xml,application/xml,text/plain", parseExceedSessions),
      },
      {
        label: t("sessionTree.contextImportSecureCrt"),
        icon: <Upload className="w-3 h-3" />,
        children: [
          {
            label: t("sessionTree.fromIniFile"),
            icon: <FileText className="w-3 h-3" />,
            onClick: () => importSources.importTextSessions(folderPath, "SecureCRT", ".ini,text/plain", parseSecureCrtSessions),
          },
          {
            label: t("sessionTree.fromLocalSecureCrt"),
            icon: <FolderOpen className="w-3 h-3" />,
            onClick: () => importSources.importScannedTextSessions(folderPath, "securecrt", "SecureCRT", parseSecureCrtSessions),
          },
        ],
      },
      {
        label: t("sessionTree.contextImportRdm"),
        icon: <Upload className="w-3 h-3" />,
        onClick: () => importSources.importTextSessions(folderPath, "Remote Desktop Manager", ".rdm,.xml,text/xml,application/xml", parseXmlConnectionSessions),
      },
      {
        label: t("sessionTree.contextImportZeroOmega"),
        icon: <Upload className="w-3 h-3" />,
        onClick: () => importSources.importTextSessions(folderPath, "ZeroOmega", ".bak,.json,application/json,text/plain", parseZeroOmegaProxies),
      },
      { label: "", separator: true },
      {
        label: t("sessionTree.contextImportCsv"),
        icon: <FileText className="w-3 h-3" />,
        onClick: () => importCsv(folderPath),
      },
      {
        label: t("sessionTree.contextDownloadCsvTemplate"),
        icon: <FileText className="w-3 h-3" />,
        onClick: exports.downloadCsvTemplate,
      },
    ];

    ctx.show(e, [
      { label: t("sessionTree.contextNewSession"), icon: <Plus className="w-3 h-3" />, onClick: () => onNewSession?.(toStoredGroupPath(folderPath)) },
      { label: t("sessionTree.contextNewFolder"), icon: <FolderPlus className="w-3 h-3" />, onClick: () => createFolder(folderPath) },
      { label: t("sessionTree.contextEditFolder"), icon: <Edit3 className="w-3 h-3" />, disabled: isRoot, onClick: () => { if (normalized) renameFolder(normalized); } },
      { label: t("sessionTree.contextDeleteFolder"), icon: <Trash2 className="w-3 h-3" />, danger: true, disabled: isRoot, onClick: () => { if (normalized) deleteFolder(normalized); } },
      { label: t("sessionTree.contextCreateDesktopShortcut"), icon: <Star className="w-3 h-3" />, onClick: () => importSources.unavailable(t("sessionTree.contextCreateDesktopShortcut")) },
      { label: "", separator: true },
      { label: t("sessionTree.contextImportTaomni"), icon: <Upload className="w-3 h-3" />, onClick: () => importJson(folderPath) },
      { label: t("sessionTree.contextImportThirdParty"), icon: <Upload className="w-3 h-3" />, children: importChildren },
      { label: "", separator: true },
      { label: t("sessionTree.contextExportTaomni"), icon: <Download className="w-3 h-3" />, disabled: folderSessions.length === 0, onClick: () => exports.exportFolder(folderPath) },
      { label: t("sessionTree.contextExportMoba"), icon: <Download className="w-3 h-3" />, disabled: folderSessions.length === 0, onClick: () => exports.exportMobaFolder(folderPath) },
      { label: t("sessionTree.contextExportCsv"), icon: <FileText className="w-3 h-3" />, disabled: folderSessions.length === 0, onClick: () => exports.exportCsvFolder(folderPath) },
      { label: t("sessionTree.contextGenerateHtml"), icon: <FileText className="w-3 h-3" />, disabled: folderSessions.length === 0, onClick: () => exports.generateHtml(folderPath) },
      { label: "", separator: true },
      { label: t("sessionTree.contextExecuteAll"), icon: <Play className="w-3 h-3" />, disabled: folderSessions.length === 0 || !onConnectSession, onClick: () => executeFolder(folderPath) },
      { label: "", separator: true },
      { label: t("sessionTree.contextShare"), icon: <Share2 className="w-3 h-3" />, onClick: () => importSources.unavailable(t("sessionTree.contextShare")) },
    ]);
  };
  return { folderContextMenu };
}
