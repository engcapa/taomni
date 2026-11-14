import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { startCustomDrag } from "../../lib/customDnD";
import { observeElementOffsetClean } from "../../lib/virtualOffsetObserver";
import { effectiveFileType, formatBytes } from "../../lib/sftp";
import { getAppPlatform } from "../../lib/runtime";
import { useSftpStore } from "../../stores/sftpStore";
import type { FilePanelViewProps } from "../filebrowser/filePanel/FilePanelView";
import { ExplorerFileIcon } from "./ExplorerFileIcon";
import { useExplorerContext } from "./ExplorerContext";
import { useExplorerPreferences } from "./explorerPreferences";
import { useExplorerLabels } from "./explorerLabels";
import { ExplorerRenameInput } from "./ExplorerRenameInput";
import { useExplorerClipboard } from "./explorerClipboard";
import { EXPLORER_DRAG_MIME, type ExplorerDragPayload } from "./useExplorerDrop";

interface Rubber { left: number; top: number; width: number; height: number }
/** Explorer presentation; FilePanel still owns sorting, filtering and pane selection. */
export function ExplorerFileList(inputs: FilePanelViewProps) {
  const { pane, sortedEntries: entries, interactions } = inputs;
  const { operations, dropPath } = useExplorerContext();
  const preferences = useExplorerPreferences();
  const label = useExplorerLabels();
  const clipboard = useExplorerClipboard();
  const selected = useMemo(() => new Set(pane.selection), [pane.selection]);
  const cut = useMemo(() => new Set(clipboard?.cut ? clipboard.paths : []), [clipboard]);
  const scroll = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [focused, setFocused] = useState<string | null>(null);
  const [rubber, setRubber] = useState<Rubber | null>(null);
  const rubberCleanup = useRef<(() => void) | null>(null);
  const anchor = useRef<string | null>(null);
  const icons = preferences.view === "icons";
  const columns = icons ? Math.max(1, Math.floor((width - 16) / 96)) : 1;
  const rowHeight = icons ? 96 : preferences.view === "list" ? 24 : 28;
  const virtual = useVirtualizer({
    count: Math.ceil(entries.length / columns), getScrollElement: () => scroll.current,
    estimateSize: () => rowHeight, overscan: 8, observeElementOffset: observeElementOffsetClean,
  });
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { virtual.measure(); }, [rowHeight, columns, virtual, entries.length]);
  useEffect(() => {
    // A first render with no rows can leave TanStack's estimate at zero in a
    // browser worker. Re-measure after the actual rows commit so file rows are
    // mounted and the Explorer opener never targets an empty virtual window.
    const frame = requestAnimationFrame(() => virtual.measure());
    return () => cancelAnimationFrame(frame);
  }, [entries, virtual]);
  useEffect(() => { scroll.current?.scrollTo?.({ top: 0 }); anchor.current = null; setFocused(null); }, [pane.path, inputs.filterText, preferences.view, inputs.sortKey, inputs.sortDir]);
  useEffect(() => () => rubberCleanup.current?.(), []);
  useEffect(() => {
    if (!operations.renamePath) return;
    const index = entries.findIndex((entry) => entry.path === operations.renamePath);
    if (index >= 0) virtual.scrollToIndex(Math.floor(index / columns), { align: "auto" });
  }, [operations.renamePath, columns, entries, virtual]);
  // Use the same store as FilePanel; Explorer has no independent selection model.
  const selectNow = (paths: string[]) => useSftpStore.getState().setSelection(inputs.sessionId, "local", paths);
  const handleKeys = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing || (event.target as HTMLElement).closest("input,textarea,[contenteditable=true]")) return;
    const mod = getAppPlatform() === "macos" ? event.metaKey : event.ctrlKey;
    if (mod && !event.altKey && !event.shiftKey && !(getAppPlatform() === "macos" ? event.ctrlKey : event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault(); event.stopPropagation(); selectNow(entries.map((entry) => entry.path)); return;
    }
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", " "].includes(event.key) || event.altKey || mod) return;
    if (!entries.length) return;
    event.preventDefault(); event.stopPropagation();
    let index = entries.findIndex((entry) => entry.path === (focused ?? pane.selection.at(-1)));
    if (event.key === "Home") index = 0;
    else if (event.key === "End") index = entries.length - 1;
    else if (event.key !== " ") {
      const delta = event.key === "ArrowDown" ? columns : event.key === "ArrowUp" ? -columns : event.key === "ArrowRight" ? 1 : -1;
      index = index < 0 ? 0 : Math.max(0, Math.min(entries.length - 1, index + delta));
    }
    index = Math.max(0, index);
    const path = entries[index].path;
    setFocused(path);
    if (event.shiftKey && anchor.current) {
      const start = Math.max(0, entries.findIndex((entry) => entry.path === anchor.current));
      selectNow(entries.slice(Math.min(index, start), Math.max(index, start) + 1).map((entry) => entry.path));
    } else { selectNow([path]); anchor.current = path; }
    virtual.scrollToIndex(Math.floor(index / columns), { align: "auto" });
  };
  const rubberStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("[data-row],button,input")) return;
    const element = scroll.current;
    if (!element) return;
    event.preventDefault(); element.focus();
    const rect = element.getBoundingClientRect();
    const startX = event.clientX - rect.left + element.scrollLeft;
    const startY = event.clientY - rect.top + element.scrollTop;
    const original = event.ctrlKey || event.metaKey ? pane.selection : [];
    let moved = false;
    const update = (next: PointerEvent) => {
      const x = next.clientX - rect.left + element.scrollLeft;
      const y = next.clientY - rect.top + element.scrollTop;
      const box = { left: Math.min(x, startX), top: Math.min(y, startY), width: Math.abs(x - startX), height: Math.abs(y - startY) };
      if (!moved && box.width + box.height < 4) return;
      moved = true; setRubber(box);
      const paths = new Set(original);
      const offset = icons ? 8 : 0;
      const first = Math.max(0, Math.floor((box.top - offset) / rowHeight));
      const last = Math.min(Math.ceil(entries.length / columns) - 1, Math.floor((box.top + box.height - offset) / rowHeight));
      for (let row = first; row <= last; row++) {
        const top = offset + row * rowHeight;
        const bottom = top + (icons ? 92 : rowHeight);
        if (bottom <= box.top || top >= box.top + box.height) continue;
        for (let col = 0; col < columns; col++) {
          const index = row * columns + col;
          const left = icons ? 8 + col * 96 : 4;
          const right = icons ? left + 92 : width - 4;
          if (entries[index] && right > box.left && left < box.left + box.width) paths.add(entries[index].path);
        }
      }
      selectNow([...paths]);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", update); window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish); window.removeEventListener("blur", finish);
      setRubber(null); rubberCleanup.current = null;
    };
    const finish = () => { if (!moved) selectNow(original); cleanup(); };
    rubberCleanup.current?.(); rubberCleanup.current = cleanup;
    window.addEventListener("pointermove", update); window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish); window.addEventListener("blur", finish);
  };
  return <div className={`ex-files ${preferences.view === "list" ? "compact" : ""}`} data-testid="explorer-files" data-explorer-drop={pane.path}>
    {!icons && <div className="ex-fhead" role="row">
      {([ ["name", label("名称", "Name"), "ex-name"], ["mtime", label("修改日期", "Date modified"), "ex-mod"], ["type", label("类型", "Type"), "ex-type"], ["size", label("大小", "Size"), "ex-size"] ] as const).map(([key, title, cls]) =>
        <button key={key} data-testid={`explorer-column-${key}`} className={`${cls} ${inputs.sortKey === key ? "on" : ""}`} onClick={() => inputs.onHeaderClick(key)}>{title}{inputs.sortKey === key ? inputs.sortDir === "asc" ? " ▲" : " ▼" : ""}</button>)}
    </div>}
    <div ref={scroll} className={`ex-fbody ${dropPath === pane.path ? "ex-drop" : ""}`} data-testid="explorer-file-list" role="listbox" aria-multiselectable="true" aria-label={label("文件", "Files")} tabIndex={0}
      onKeyDown={handleKeys} onPointerDown={rubberStart} onContextMenu={interactions.handleEmptyContext}>
      {inputs.skippedEntryCount > 0 && <div className="ex-warning" role="status" title={inputs.diagnosticTitle}>{label(`${inputs.skippedEntryCount} 个项目无法读取`, `${inputs.skippedEntryCount} unreadable items`)}</div>}
      {!entries.length && !pane.loading && !pane.error && <div className="ex-empty">{label(inputs.filterActive ? "没有匹配的项目" : "此文件夹为空", inputs.filterActive ? "No matching items" : "This folder is empty")}<br /><small>{label("右键可新建文件夹/文件，或把文件拖到这里", "Right-click to create a file or folder, or drag files here")}</small></div>}
      {pane.loading && !entries.length && <div className="ex-empty" role="status">{label("正在加载…", "Loading…")}</div>}
      <div style={{ height: virtual.getTotalSize() + (icons ? 16 : 0), position: "relative", minWidth: icons ? undefined : preferences.view === "list" ? 0 : 460 }}>
        {virtual.getVirtualItems().flatMap((row) => Array.from({ length: columns }, (_, col) => {
          const entry = entries[row.index * columns + col];
          if (!entry) return null;
          const directory = effectiveFileType(entry) === "dir";
          const renaming = operations.renamePath === entry.path;
          return <div key={entry.path} data-row data-testid="explorer-file-row" data-path={entry.path} data-name={entry.name} role="option" aria-selected={selected.has(entry.path)}
            data-explorer-drop={directory ? entry.path : undefined}
            className={`${icons ? "ex-tile" : "ex-frow"} ${selected.has(entry.path) ? "sel" : ""} ${cut.has(entry.path) ? "cut" : ""} ${focused === entry.path ? "focus" : ""} ${dropPath === entry.path ? "ex-drop" : ""}`}
            style={{ top: row.start + (icons ? 8 : 0), ...(icons ? { left: 8 + col * 96 } : {}) }} title={entry.path}
            onPointerDown={(event) => {
              if ((event.target as HTMLElement).closest("input") || event.button !== 0) return;
              const paths = selected.has(entry.path) ? pane.selection : [entry.path];
              startCustomDrag({ event, data: { mime: EXPLORER_DRAG_MIME, payload: { paths } satisfies ExplorerDragPayload },
                ghostText: paths.length === 1 ? entry.name : label(`${paths.length} 项`, `${paths.length} items`),
                onActivate: () => { if (!selected.has(entry.path)) selectNow(paths); },
              });
            }}
            onClick={(event) => { if (renaming) return; interactions.handleRowClick(entry, event); setFocused(entry.path); if (!event.shiftKey) anchor.current = entry.path; scroll.current?.focus(); }}
            onDoubleClick={(event) => { if (!renaming) { if (event.ctrlKey || event.metaKey) { void operations.open(entry, true); } else inputs.onItemDoubleClick(entry); } }} onContextMenu={(event) => interactions.handleRowContext(entry, event)}>
            {icons ? <><ExplorerFileIcon entry={entry} /><div className="ex-tile-name">{renaming ? <ExplorerRenameInput entry={entry} /> : entry.name}</div></> : <>
              <div className="ex-name"><ExplorerFileIcon entry={entry} /><span className="truncate flex-1">{renaming ? <ExplorerRenameInput entry={entry} /> : entry.name}</span></div>
              <div className="ex-mod">{entry.mtime ? new Date(entry.mtime * 1000).toLocaleString(undefined, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""}</div>
              <div className="ex-type">{directory ? label("文件夹", "File folder") : entry.name.includes(".") ? entry.name.split(".").at(-1)?.toUpperCase() : label("文件", "File")}</div>
              <div className="ex-size">{directory ? "" : formatBytes(entry.size)}</div>
            </>}
          </div>;
        }))}
        {rubber && <div className="ex-rubber" style={rubber} />}
      </div>
    </div>
    {inputs.ctx.render}
  </div>;
}
