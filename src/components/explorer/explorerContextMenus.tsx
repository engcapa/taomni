import { ClipboardPaste, Copy, ExternalLink, FilePlus, FolderPlus, Info, Link, Pencil, RefreshCw, Scissors, Terminal, Trash2 } from "lucide-react";
import { effectiveFileType, type FileEntry } from "../../lib/sftp";
import { getAppPlatform } from "../../lib/runtime";
import type { MenuItem } from "../ContextMenu";
import type { ExplorerOperations } from "./useExplorerOperations";
import { fileOpenMenu } from "./fileOpenMenu";

type Label = (zh: string, en: string) => string;
export function explorerItemMenu(entries: FileEntry[], path: string, operations: ExplorerOperations, label: Label,
  openExplorer: (path: string, forceNew?: boolean) => void, terminal: (path: string) => void, workspaceId?: string): MenuItem[] {
  const first = entries[0];
  const multi = entries.length !== 1;
  const directory = !multi && effectiveFileType(first) === "dir";
  const mod = getAppPlatform() === "macos" ? "⌘" : "Ctrl+";
  return [
    ...(!multi && !directory ? [{ label: label("打开方式", "Open with"), testId: "explorer-context-open-with", children: fileOpenMenu(first.path, workspaceId, label, (message) => operations.notify(message, true)) }] : []),
    { label: label("打开", "Open"), testId: "explorer-context-open", icon: <ExternalLink />, shortcut: "Enter", onClick: () => { for (const entry of entries) void operations.open(entry); } },
    ...(directory ? [{ label: label("在新的 Explorer 标签中打开", "Open in new Explorer tab"), testId: "explorer-context-newtab", icon: <ExternalLink />, onClick: () => openExplorer(first.path, true) }] : []),
    { label: label("在终端中打开", "Open in terminal"), testId: "explorer-context-terminal", icon: <Terminal />, onClick: () => terminal(directory ? first.path : path) },
    { label: "", separator: true },
    { label: label("剪切", "Cut"), testId: "explorer-context-cut", icon: <Scissors />, shortcut: `${mod}X`, disabled: operations.busy, onClick: () => void operations.copy(entries, true) },
    { label: label("复制", "Copy"), testId: "explorer-context-copy", icon: <Copy />, shortcut: `${mod}C`, onClick: () => void operations.copy(entries, false) },
    { label: label("复制路径", "Copy path"), testId: "explorer-context-copy-path", icon: <Link />, onClick: () => void operations.copyPath(entries.map((entry) => entry.path)) },
    { label: "", separator: true },
    { label: label("重命名", "Rename"), testId: "explorer-context-rename", icon: <Pencil />, shortcut: "F2", disabled: multi || operations.busy, onClick: () => operations.setRenamePath(first.path) },
    { label: label("删除（移到回收站）", "Delete (move to Trash)"), testId: "explorer-context-delete", icon: <Trash2 />, shortcut: "Del", danger: true, disabled: operations.busy, onClick: () => operations.remove(entries) },
    { label: "", separator: true },
    { label: label("属性", "Properties"), testId: "explorer-context-properties", icon: <Info />, shortcut: "Alt+Enter", onClick: () => operations.setProperties(entries) },
  ];
}
export function explorerEmptyMenu(path: string, operations: ExplorerOperations, label: Label, refresh: () => void): MenuItem[] {
  return [
    { label: label("新建文件夹", "New folder"), testId: "explorer-context-new-folder", icon: <FolderPlus />, disabled: operations.busy, onClick: () => void operations.create(true) },
    { label: label("新建文本文件", "New text file"), testId: "explorer-context-new-file", icon: <FilePlus />, disabled: operations.busy, onClick: () => void operations.create(false) },
    { label: "", separator: true },
    { label: label("粘贴", "Paste"), testId: "explorer-context-paste", icon: <ClipboardPaste />, disabled: operations.busy, onClick: () => void operations.paste() },
    { label: "", separator: true },
    { label: label("刷新", "Refresh"), testId: "explorer-context-refresh", icon: <RefreshCw />, shortcut: "F5", onClick: refresh },
    { label: label("在系统文件管理器中显示", "Show in system file manager"), testId: "explorer-context-reveal", icon: <ExternalLink />, onClick: () => void operations.reveal(path) },
  ];
}
