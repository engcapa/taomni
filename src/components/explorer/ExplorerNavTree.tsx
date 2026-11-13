import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, HardDrive, Home } from "lucide-react";
import { joinPath, sftpListLocalDetailed, sftpLocalDrives, type DriveEntry, type FileEntry } from "../../lib/sftp";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { useContextMenu } from "../ContextMenu";
import { ExplorerFileIcon } from "./ExplorerFileIcon";
import { explorerCrumbs, sameExplorerPath } from "./explorerPaths";
import { setExplorerPreferences, useExplorerPreferences } from "./explorerPreferences";
import { useExplorerLabels } from "./explorerLabels";

interface Listing { entries: FileEntry[]; error?: string }
export function ExplorerNavTree({ home, path, dropPath, onNavigate, onOpenExplorer, onOpenTerminal }: {
  home: string; path: string; dropPath: string | null;
  onNavigate: (path: string) => void; onOpenExplorer: (path: string, forceNew?: boolean) => void;
  onOpenTerminal: (path: string) => void;
}) {
  const label = useExplorerLabels();
  const preferences = useExplorerPreferences();
  const workspaces = useWorkspacePlatformStore((state) => state.workspaces);
  const [drives, setDrives] = useState<DriveEntry[]>([]);
  const [driveError, setDriveError] = useState("");
  const [listing, setListing] = useState<Record<string, Listing>>({});
  const pending = useRef(new Set<string>());
  const mounted = useRef(true);
  const ctx = useContextMenu();
  const load = useCallback(async (directory: string, retry = false) => {
    if (pending.current.has(directory) || (!retry && listing[directory])) return;
    pending.current.add(directory);
    try {
      const result = await sftpListLocalDetailed(directory);
      if (mounted.current) setListing((state) => ({ ...state, [directory]: { entries: result.entries.filter((item) => item.fileType === "dir" || item.targetFileType === "dir") } }));
    } catch (error) {
      if (mounted.current) setListing((state) => ({ ...state, [directory]: { entries: [], error: String(error) } }));
    } finally { pending.current.delete(directory); }
  }, [listing]);
  useEffect(() => {
    mounted.current = true;
    void sftpLocalDrives().then((items) => { if (mounted.current) setDrives(items); }).catch((error) => { if (mounted.current) setDriveError(String(error)); });
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    // Auto-expand the committed path without loading an entire filesystem tree.
    for (const crumb of explorerCrumbs(path)) void load(crumb.path);
    for (const expanded of preferences.expandedPaths) void load(expanded);
  }, [path, preferences.expandedPaths, load]);
  const autoPaths = explorerCrumbs(path).map((crumb) => crumb.path);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (directory: string, open: boolean) => {
    const expanded = preferences.expandedPaths.filter((value) => value !== directory);
    if (!open) expanded.push(directory);
    setExplorerPreferences({ expandedPaths: expanded });
    setCollapsed((old) => { const next = new Set(old); if (open) next.add(directory); else next.delete(directory); return next; });
    if (!open) void load(directory, !!listing[directory]?.error);
  };
  const menu = (event: React.MouseEvent, directory: string) => ctx.show(event, [
    { label: label("打开", "Open"), onClick: () => onNavigate(directory) },
    { label: label("在新的 Explorer 标签中打开", "Open in new Explorer tab"), testId: "explorer-nav-newtab", onClick: () => onOpenExplorer(directory, true) },
    { label: label("在终端中打开", "Open in terminal"), onClick: () => onOpenTerminal(directory) },
    ...(preferences.pinnedPaths.includes(directory) ? [{ label: label("取消固定到快速访问", "Unpin from Quick access"), onClick: () => setExplorerPreferences({ pinnedPaths: preferences.pinnedPaths.filter((value) => value !== directory) }) }] : []),
  ]);
  const quickRow = (directory: string, name: string, isHome = false) => <div key={directory} role="treeitem" aria-selected={sameExplorerPath(directory, path)}
    className={`ex-nav-row ${sameExplorerPath(directory, path) ? "on" : ""} ${dropPath === directory ? "ex-drop" : ""}`}
    data-testid="explorer-nav-shortcut" data-path={directory} data-explorer-drop={directory}
    tabIndex={0} onClick={() => onNavigate(directory)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); onNavigate(directory); } }}
    onContextMenu={(event) => menu(event, directory)} title={directory}>
    <span className="ex-tw" />{isHome ? <Home /> : <ExplorerFileIcon directory />}<span className="ex-nav-label">{name}</span>
  </div>;
  const tree = (directory: string, name: string, depth: number, drive = false, ancestors = new Set<string>()): React.ReactNode => {
    if (depth > 32 || ancestors.has(directory)) return null;
    const branch = new Set(ancestors); branch.add(directory);
    const open = !collapsed.has(directory) && (preferences.expandedPaths.includes(directory) || autoPaths.some((value) => sameExplorerPath(value, directory)));
    const cached = listing[directory];
    const children = cached?.entries.filter((item) => preferences.showHidden || !item.isHidden || autoPaths.some((value) => sameExplorerPath(value, item.path))).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })) ?? [];
    return <div key={directory} role="none">
      <div className={`ex-nav-row ${sameExplorerPath(path, directory) ? "on" : ""} ${dropPath === directory ? "ex-drop" : ""}`} role="treeitem" aria-selected={sameExplorerPath(path, directory)} aria-expanded={open}
        data-testid="explorer-nav-node" data-path={directory} data-explorer-drop={directory} tabIndex={0}
        style={{ paddingLeft: 6 + depth * 14 }} title={directory} onClick={() => onNavigate(directory)} onContextMenu={(event) => menu(event, directory)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (["Enter", "ArrowRight", "ArrowLeft"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); }
          if (event.key === "Enter") onNavigate(directory);
          if (event.key === "ArrowRight" && !open) toggle(directory, false);
          if (event.key === "ArrowLeft" && open) toggle(directory, true);
        }}>
        <button className="ex-tw" aria-label={label(open ? "折叠" : "展开", open ? "Collapse" : "Expand") + " " + name} onClick={(event) => { event.stopPropagation(); toggle(directory, open); }}>{open ? <ChevronDown /> : <ChevronRight />}</button>
        {drive ? <HardDrive /> : <ExplorerFileIcon directory />}<span className="ex-nav-label">{name}</span>
      </div>
      {open && <div role="group">
        {cached?.error ? <button className="ex-warning" title={cached.error} onClick={() => void load(directory, true)}>{label("读取失败，点击重试", "Unable to read; retry")}</button>
          : cached ? children.map((item) => tree(item.path, item.name, depth + 1, false, branch)) : <div className="ex-warning">{label("正在加载…", "Loading…")}</div>}
      </div>}
    </div>;
  };
  const roots = drives.length ? [...drives] : [{ id: "root", path: "/", label: label("/ （根）", "/ (Root)") }];
  const currentRoot = explorerCrumbs(path)[0];
  if (currentRoot && /^[\\/]{2}/.test(currentRoot.path) && !roots.some((drive) => sameExplorerPath(drive.path, currentRoot.path))) {
    roots.push({ id: currentRoot.path, path: currentRoot.path, label: currentRoot.name });
  }
  const workspaceRoots = [...new Map(workspaces.flatMap((workspace) => workspace.rootFolders.map((root) => [root.path, { path: root.path, name: root.name || workspace.name }] as const))).values()];
  return <nav className="ex-nav" data-testid="explorer-nav-tree" aria-label={label("文件夹导航", "Folder navigation")} style={{ width: preferences.navWidth }} role="tree">
    <div className="ex-nav-sec">{label("快速访问", "Quick access")}</div>
    {home && quickRow(home, label("主目录", "Home"), true)}
    {home && [["Desktop", label("桌面", "Desktop")], ["Documents", label("文档", "Documents")], ["Downloads", label("下载", "Downloads")], ["Pictures", label("图片", "Pictures")]].map(([folder, name]) => quickRow(joinPath(home, folder), name))}
    {preferences.pinnedPaths.filter((value) => value !== home).map((directory) => quickRow(directory, explorerCrumbs(directory).at(-1)?.name ?? directory))}
    <div className="ex-nav-sec">{label("工作区", "Workspaces")}</div>
    {workspaceRoots.map((root) => quickRow(root.path, root.name))}
    <div className="ex-nav-sec">{label("此电脑", "This PC")}</div>
    {driveError && <div className="ex-warning" role="alert">{driveError}</div>}
    {roots.map((drive) => tree(drive.path, drive.label, 0, true))}
    {ctx.render}
  </nav>;
}
