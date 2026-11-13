import { useEffect, useRef, useState, type RefObject } from "react";
import { ArrowLeft, ArrowRight, ArrowUp, ChevronRight, HardDrive, RefreshCw, Search } from "lucide-react";
import { useContextMenu } from "../ContextMenu";
import { isWindowsPath, resolvePathInput } from "../../lib/pathCompletion";
import { sftpListLocalDetailed, type FileEntry } from "../../lib/sftp";
import type { PaneState } from "../../stores/sftpStore";
import { useSftpStore } from "../../stores/sftpStore";
import { explorerCrumbs } from "./explorerPaths";
import { normalizeExplorerInput } from "./explorerPathInput";
import { ExplorerFileIcon } from "./ExplorerFileIcon";
import { useExplorerLabels } from "./explorerLabels";
import { useExplorerPreferences } from "./explorerPreferences";

export function ExplorerAddressBar({ tabId, pane, home, filter, onFilter, addressRef }: {
  tabId: string; pane?: PaneState; home: string; filter: string; onFilter: (value: string) => void;
  addressRef: RefObject<HTMLInputElement | null>;
}) {
  const label = useExplorerLabels();
  const preferences = useExplorerPreferences();
  const navigate = useSftpStore((state) => state.navigate);
  const navigateBack = useSftpStore((state) => state.navigateBack);
  const navigateForward = useSftpStore((state) => state.navigateForward);
  const navigateUp = useSftpStore((state) => state.navigateUp);
  const refreshPane = useSftpStore((state) => state.refreshPane);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(pane?.path ?? "");
  const ctx = useContextMenu();
  const crumbContainer = useRef<HTMLDivElement>(null);
  const path = pane?.path ?? "";
  const crumbs = explorerCrumbs(path);
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);
  useEffect(() => { request.current++; ctx.close(); }, [path, ctx.close]);
  useEffect(() => { if (!editing) setValue(path); }, [path, editing]);
  useEffect(() => { crumbContainer.current?.querySelector(".ex-crumb.last")?.scrollIntoView?.({ block: "nearest", inline: "end" }); }, [path]);
  const go = (next: string) => { void navigate(tabId, "local", next); };
  const subfolders = async (event: React.MouseEvent, entry: { path: string }) => {
    const sequence = ++request.current;
    const anchor = event.currentTarget.getBoundingClientRect();
    try {
      const result = await sftpListLocalDetailed(entry.path);
      if (sequence !== request.current) return;
      const children: FileEntry[] = result.entries.filter((item) => item.fileType === "dir" && (preferences.showHidden || !item.isHidden));
      ctx.showAt(anchor.left, anchor.bottom + 4, children.length ? children.map((child) => ({
        label: child.name, icon: <ExplorerFileIcon entry={child} />, onClick: () => go(child.path),
      })) : [{ label: label("（无子目录）", "(No subfolders)"), disabled: true }]);
    } catch (error) {
      if (sequence === request.current) ctx.showAt(anchor.left, anchor.bottom + 4, [{ label: String(error), disabled: true }]);
    }
  };
  return <>
    <div className="ex-top">
      <button className="ex-nbtn" data-testid="explorer-back" title={label("后退 (Alt+←)", "Back (Alt+←)")} disabled={!pane || pane.historyIndex <= 0} onClick={() => void navigateBack(tabId, "local")}><ArrowLeft /></button>
      <button className="ex-nbtn" data-testid="explorer-forward" title={label("前进 (Alt+→)", "Forward (Alt+→)")} disabled={!pane || pane.historyIndex >= pane.history.length - 1} onClick={() => void navigateForward(tabId, "local")}><ArrowRight /></button>
      <button className="ex-nbtn" data-testid="explorer-up" title={label("上一级 (Alt+↑)", "Up (Alt+↑)")} disabled={!path || path === "/" || path === "\\\\"} onClick={() => void navigateUp(tabId, "local")}><ArrowUp /></button>
      <button className="ex-nbtn" data-testid="explorer-refresh" title={label("刷新 (F5)", "Refresh (F5)")} disabled={pane?.loading} onClick={() => void refreshPane(tabId, "local")}><RefreshCw className={pane?.loading ? "animate-spin" : ""} /></button>
      <div className="ex-address" data-testid="explorer-address-bar" onClick={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        setEditing(true);
        setValue(path);
        requestAnimationFrame(() => { addressRef.current?.focus(); addressRef.current?.select(); });
      }}>
        {!editing && <div className="ex-crumbs" ref={crumbContainer}>
          {crumbs.map((crumb, index) => <span key={crumb.path} className="inline-flex shrink-0 items-center">
            <button className={`ex-crumb ${index === crumbs.length - 1 ? "last" : ""}`} data-explorer-drop={crumb.path} data-testid="explorer-crumb" data-path={crumb.path} title={crumb.path} onClick={() => go(crumb.path)}>{index === 0 ? <HardDrive /> : crumb.name}</button>
            {index < crumbs.length - 1 && <button className="ex-csep" title={label("显示子目录", "Show subfolders")} onClick={(event) => void subfolders(event, crumb)}><ChevronRight /></button>}
          </span>)}
        </div>}
        <input ref={addressRef} data-testid="explorer-address" aria-label={label("地址", "Address")} spellCheck={false} value={value}
          style={editing ? undefined : { position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
          onFocus={() => { if (!editing) { setValue(path); setEditing(true); } }} onChange={(event) => setValue(event.target.value)}
          onBlur={() => setEditing(false)} onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape") { event.stopPropagation(); setEditing(false); addressRef.current?.blur(); }
            if (event.key === "Enter") {
              event.preventDefault();
              go(normalizeExplorerInput(resolvePathInput(value, path, home, isWindowsPath(path))));
              setEditing(false); addressRef.current?.blur();
            }
          }} />
      </div>
      <label className="ex-search"><Search /><input data-testid="explorer-filter" aria-label={label("筛选当前文件夹", "Filter current folder")} placeholder={label("搜索 ", "Search ") + (crumbs.at(-1)?.name ?? "")} value={filter} onChange={(event) => onFilter(event.target.value)} /></label>
    </div>
    {pane?.error && <div className="ex-error" data-testid="explorer-address-error" role="alert"><span className="ex-sp">{pane.error}</span><button onClick={() => void refreshPane(tabId, "local")}>{label("重试", "Retry")}</button><button onClick={() => void navigateUp(tabId, "local")}>{label("上一级", "Up")}</button></div>}
    {ctx.render}
  </>;
}
