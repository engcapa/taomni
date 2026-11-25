import { ArrowDownWideNarrow, ChevronDown, ClipboardPaste, Copy, ExternalLink, FolderPlus, LayoutGrid, List, MoreHorizontal, PanelLeftClose, PanelLeftOpen, PanelRight, Pencil, Plus, Scissors, Terminal, Trash2 } from "lucide-react";
import type { FileEntry } from "../../lib/sftp";
import { readExplorerRestoreEnabled, setExplorerRestoreEnabled } from "../../lib/explorer/tabRecovery";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { setExplorerPreferences, useExplorerPreferences } from "./explorerPreferences";
import { useExplorerLabels } from "./explorerLabels";
import type { ExplorerOperations } from "./useExplorerOperations";
import { fileOpenMenu } from "./fileOpenMenu";
import { classifyFile, supportsFileViewer } from "../../lib/openFile";
import { openFile } from "../../lib/openFile";
import { EXPLORER_TEXT_FILE_TYPES } from "./explorerFileTypes";

export function ExplorerCommandBar({ path, workspaceId, selected, operations, onOpenTerminal, onOpenExplorer, previewVisible, onTogglePreview, navigationId, onToggleNavigation }: {
  path: string; workspaceId?: string; selected: FileEntry[]; operations: ExplorerOperations;
  onOpenTerminal: (path: string) => void; onOpenExplorer: (path: string, forceNew?: boolean) => void;
  previewVisible: boolean; onTogglePreview: () => void;
  navigationId: string; onToggleNavigation: () => void;
}) {
  const preferences = useExplorerPreferences();
  const label = useExplorerLabels();
  const ctx = useContextMenu();
  const show = (event: React.MouseEvent, items: MenuItem[]) => { const rect = event.currentTarget.getBoundingClientRect(); ctx.showAt(rect.left, rect.bottom + 4, items); };
  const newMenu: MenuItem[] = [
    { label: label("文件夹", "Folder"), icon: <FolderPlus />, testId: "explorer-new-folder", onClick: () => void operations.create(true) },
    ...EXPLORER_TEXT_FILE_TYPES.map((fileType) => ({
      label: label(fileType.zh, fileType.en), icon: <Plus />, testId: fileType.extension === "txt" ? "explorer-new-file" : `explorer-new-file-${fileType.extension}`,
      onClick: () => void operations.create(false, fileType.extension),
    })),
    { label: label("其他文件类型…", "Other file types…"), icon: <Plus />, testId: "explorer-new-typed-file", onClick: operations.startNewFile },
    { label: "", separator: true },
    { label: label("从剪贴板粘贴文件", "Paste files from clipboard"), icon: <ClipboardPaste />, onClick: () => void operations.paste() },
  ];
  const sortMenu: MenuItem[] = [
    ...([ ["name", label("名称", "Name")], ["mtime", label("修改日期", "Date modified")], ["type", label("类型", "Type")], ["size", label("大小", "Size")] ] as const).map(([key, title]) => ({
      label: title, checked: preferences.sortKey === key, testId: `explorer-sort-${key}`, onClick: () => setExplorerPreferences({ sortKey: key }),
    })),
    { label: "", separator: true },
    { label: label("升序", "Ascending"), checked: preferences.sortDir === "asc", testId: "explorer-sort-asc", onClick: () => setExplorerPreferences({ sortDir: "asc" }) },
    { label: label("降序", "Descending"), checked: preferences.sortDir === "desc", testId: "explorer-sort-desc", onClick: () => setExplorerPreferences({ sortDir: "desc" }) },
  ];
  const viewMenu: MenuItem[] = [
    ...([ ["icons", label("大图标", "Large icons")], ["list", label("列表（紧凑）", "List (compact)")], ["details", label("详细信息", "Details")] ] as const).map(([view, title]) => ({
      label: title, checked: preferences.view === view, testId: `explorer-view-${view}`, onClick: () => setExplorerPreferences({ view }),
    })),
    { label: "", separator: true },
    { label: label("显示隐藏文件", "Show hidden files"), checked: preferences.showHidden, testId: "explorer-view-hidden", onClick: () => setExplorerPreferences({ showHidden: !preferences.showHidden }) },
    { label: label("显示文件扩展名", "Show file extensions"), checked: true, disabled: true },
  ];
  const moreMenu: MenuItem[] = [
    { label: label("复制当前路径", "Copy current path"), onClick: () => void operations.copyPath([path]) },
    { label: label("在系统文件管理器中显示", "Show in system file manager"), onClick: () => void operations.reveal(path) },
    { label: "", separator: true },
    { label: label("启动时恢复 Explorer 标签", "Restore Explorer tabs on startup"), checked: readExplorerRestoreEnabled(), testId: "explorer-restore-tabs", onClick: () => setExplorerRestoreEnabled(!readExplorerRestoreEnabled()) },
  ];
  return <>
    <div className="ex-cmd" data-testid="explorer-command-bar">
      <button type="button" className={`ex-cbtn icon ${preferences.navVisible ? "on" : ""}`}
        data-testid="explorer-cmd-navigation" aria-label={label("文件夹导航", "Folder navigation")}
        data-icon={preferences.navVisible ? "panel-left-close" : "panel-left-open"}
        aria-controls={navigationId} aria-expanded={preferences.navVisible}
        title={preferences.navVisible ? label("收起目录树", "Collapse folder tree") : label("展开目录树", "Expand folder tree")}
        onClick={(event) => { event.currentTarget.focus(); onToggleNavigation(); }}>
        {preferences.navVisible ? <PanelLeftClose aria-hidden="true" /> : <PanelLeftOpen aria-hidden="true" />}
      </button>
      <button type="button" className="ex-cbtn pri" data-testid="explorer-cmd-new" disabled={operations.busy || !path} onClick={(event) => show(event, newMenu)}><Plus />{label("新建", "New")}<ChevronDown className="ex-car" /></button>
      <span className="ex-vsep" />
      <button type="button" className="ex-cbtn icon" data-testid="explorer-cmd-cut" title={label("剪切", "Cut")} disabled={operations.busy || !selected.length} onClick={() => void operations.copy(selected, true)}><Scissors /></button>
      <button type="button" className="ex-cbtn icon" data-testid="explorer-cmd-copy" title={label("复制", "Copy")} disabled={!selected.length} onClick={() => void operations.copy(selected, false)}><Copy /></button>
      <button type="button" className="ex-cbtn icon" data-testid="explorer-cmd-paste" title={label("粘贴", "Paste")} disabled={operations.busy || !path} onClick={() => void operations.paste()}><ClipboardPaste /></button>
      <button type="button" className="ex-cbtn icon" data-testid="explorer-cmd-rename" title={label("重命名 (F2)", "Rename (F2)")} disabled={operations.busy || selected.length !== 1} onClick={() => operations.setRenamePath(selected[0].path)}><Pencil /></button>
      <button type="button" className="ex-cbtn icon" data-testid="explorer-cmd-delete" title={label("删除 (Del)", "Delete (Del)")} disabled={operations.busy || !selected.length} onClick={() => operations.remove(selected)}><Trash2 /></button>
      <span className="ex-vsep" />
      <button type="button" className="ex-cbtn" data-testid="explorer-cmd-sort" onClick={(event) => show(event, sortMenu)}><ArrowDownWideNarrow />{label("排序", "Sort")}<ChevronDown className="ex-car" /></button>
      <button type="button" className="ex-cbtn" data-testid="explorer-cmd-view" onClick={(event) => show(event, viewMenu)}>{preferences.view === "icons" ? <LayoutGrid /> : <List />}{label("查看", "View")}<ChevronDown className="ex-car" /></button>
      {selected.length === 1 && selected[0].fileType !== "dir" && <>
        {supportsFileViewer(classifyFile(selected[0].path)) && <button type="button" className="ex-cbtn" data-testid="explorer-cmd-open" onClick={() => void openFile({ path: selected[0].path }, { context: "explorer-command", workspaceId, mode: "taomni" }).catch((error) => operations.notify(String(error), true, error))}><ExternalLink />{label("用 Taomni 打开", "Open in Taomni")}</button>}
        <button type="button" className="ex-cbtn" data-testid="explorer-cmd-open-with" onClick={(event) => show(event, fileOpenMenu(selected[0].path, workspaceId, label, (message, error) => operations.notify(message, true, error)))}>{label("打开方式", "Open with")}<ChevronDown /></button>
      </>}
      <span className="ex-sp" />
      <button type="button" className="ex-cbtn icon" data-testid="explorer-cmd-terminal" title={label("在此处打开终端", "Open terminal here")} disabled={!path} onClick={() => onOpenTerminal(path)}><Terminal /></button>
      <button type="button" className="ex-cbtn icon" data-testid="explorer-cmd-newtab" title={label("在新的 Explorer 标签中打开此目录", "Open current folder in new Explorer tab")} disabled={!path} onClick={() => onOpenExplorer(path, true)}><ExternalLink /></button>
      <button type="button" className={`ex-cbtn ${previewVisible ? "on" : ""}`} data-testid="explorer-cmd-preview" title={label("预览窗格 (Alt+P)", "Preview pane (Alt+P)")} aria-pressed={preferences.preview} onClick={onTogglePreview}><PanelRight />{label("预览", "Preview")}</button>
      <button type="button" className="ex-cbtn icon" data-testid="explorer-cmd-more" title={label("更多", "More")} onClick={(event) => show(event, moreMenu)}><MoreHorizontal /></button>
    </div>
    {ctx.render}
  </>;
}
