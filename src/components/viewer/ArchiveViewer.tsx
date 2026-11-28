import { useEffect, useRef, useState } from "react";
import { selectFolderPath } from "../../lib/ipc";
import { classifyFile, openFile } from "../../lib/openFile";
import { archiveExtraction, archiveExtractionActive, listArchive, previewArchiveEntry, type ArchiveEntry } from "../../lib/openFile/archive";
import { basename, formatBytes, parentPath } from "../../lib/sftp";
import { viewerReleaseTemp } from "../../lib/viewer";
import type { FileViewerTabInfo } from "../../types";
import { useViewerLabels } from "./viewerLabels";
import { ArchiveExtractionPanel } from "./ArchiveExtractionPanel";
import { useArchiveExtraction } from "./useArchiveExtraction";
import "./archiveViewer.css";

const PAGE_SIZE = 100;
const previews = new Set(["text", "source", "markdown", "image", "svg"]);

export function ArchiveViewer({ viewer, active = true, workspaceId, host }: {
  viewer: FileViewerTabInfo; active?: boolean; workspaceId?: string; host?: "explorer";
}) {
  const label = useViewerLabels();
  const { path } = viewer;
  const [entries, setEntries] = useState<ArchiveEntry[]>();
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState("");
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const filterInput = useRef<HTMLInputElement>(null);
  const extractHere = useRef<HTMLButtonElement>(null);
  const extractTo = useRef<HTMLButtonElement>(null);
  const focusFrom = useRef<HTMLElement>(null);
  const extraction = useArchiveExtraction(path, active);
  const job = extraction.job;
  const extracting = job !== null && archiveExtractionActive(job.phase);
  const extractionBlocked = working || !extraction.ready || extracting || job?.canResume || !!extraction.pending;
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    let current = true;
    setEntries(undefined);
    setPage(0);
    setError("");
    listArchive(path).then((items) => { if (current) setEntries(items); })
      .catch((reason) => { if (current) setError(String(reason)); });
    return () => { current = false; };
  }, [path, revision]);

  async function run(action: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setWorking(true);
    setError("");
    try { await action(); } catch (reason) { if (alive.current) setError(String(reason)); }
    finally { busy.current = false; if (alive.current) setWorking(false); }
  }
  function extract(button: HTMLButtonElement, beside: boolean, entry?: ArchiveEntry) {
    void run(async () => {
      const destination = beside ? parentPath(path) : await selectFolderPath(viewer.readOnlyReason ? undefined : parentPath(path));
      if (!destination || !alive.current) return;
      focusFrom.current = button;
      const total = entry?.size ?? (entries ?? []).reduce((sum, item) => sum + (item.directory ? 0 : item.size), 0);
      await extraction.run("start", () => archiveExtraction.start(path, destination, total, entry));
    });
  }
  function preview(entry: ArchiveEntry) {
    void run(async () => {
      const temp = await previewArchiveEntry(path, entry);
      try {
        if (alive.current) {
          await openFile({ path: temp.path, source: "remote-temp", readOnlyReason: label("压缩包内只读副本", "Read-only archive entry") },
            { context: "archive-preview", mode: "taomni", workspaceId, host });
          return;
        }
      } catch (reason) { await viewerReleaseTemp(temp.path); throw reason; }
      await viewerReleaseTemp(temp.path);
    });
  }
  const matching = (entries ?? []).filter((item) => item.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const visible = matching.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  function clearFilter() {
    setFilter("");
    setPage(0);
    filterInput.current?.focus();
  }
  return <section className="fv archive-viewer" data-testid="file-viewer" data-kind="archive" data-active={active} data-path={path}>
    <header>
      <h2>{basename(path)}</h2>
      <input ref={filterInput} type="search" className="taomni-input" aria-label={label("筛选条目", "Filter entries")}
        data-testid="archive-filter" placeholder={label("筛选条目", "Filter entries")} value={filter}
        onKeyDown={(event) => {
          if (event.key === "Escape" && filter && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            clearFilter();
          }
        }}
        onChange={(event) => { setFilter(event.target.value); setPage(0); }} />
      {filter && <button type="button" className="taomni-btn" data-testid="archive-filter-clear" onClick={clearFilter}>
        {label("清除筛选", "Clear filter")}
      </button>}
      <button type="button" className="taomni-btn" disabled={working} onClick={() => setRevision((n) => n + 1)}>{label("重新加载", "Reload")}</button>
      {!viewer.readOnlyReason && viewer.source !== "remote-temp" && viewer.source !== "mail-attachment" &&
        <button type="button" className="taomni-btn" ref={extractHere} disabled={extractionBlocked || !entries?.length}
          aria-busy={extraction.pending === "start"} data-testid="archive-extract-here"
          onClick={(event) => extract(event.currentTarget, true)}>{label("解压到同目录", "Extract beside archive")}</button>}
      <button type="button" className="taomni-btn" ref={extractTo} disabled={extractionBlocked || !entries?.length}
        aria-busy={extraction.pending === "start"} data-testid="archive-extract-to"
        onClick={(event) => extract(event.currentTarget, false)}>{label("解压到…", "Extract to…")}</button>
    </header>
    {viewer.readOnlyReason && <p role="status">{viewer.readOnlyReason}</p>}
    {error && <p role="alert" className="fv-banner warn" data-testid="archive-error">{error}</p>}
    {working && <p role="status">{label("正在处理…", "Working…")}</p>}
    {extraction.error && <p role="alert" className="fv-banner warn" data-testid="archive-error">{extraction.error}</p>}
    <ArchiveExtractionPanel path={path} extraction={extraction} fallback={extractHere.current ? extractHere : extractTo} focusFrom={focusFrom} />
    {!entries && !error && <p role="status">{label("正在读取压缩包…", "Reading archive…")}</p>}
    {entries && <div className="archive-list">
      <table aria-label={label("压缩包内容", "Archive contents")}><thead><tr>
        <th>{label("名称", "Name")}</th><th>{label("大小", "Size")}</th><th>{label("操作", "Actions")}</th>
      </tr></thead><tbody>{visible.map((entry) => <tr key={entry.index} data-testid="archive-entry" data-name={entry.name}>
        <td className="taomni-mono">{entry.name}{entry.directory && "/"}</td>
        <td>{entry.directory ? "—" : formatBytes(entry.size)}</td>
        <td>{!entry.directory && <>
          {previews.has(classifyFile(entry.name)) && <button type="button" className="taomni-btn" disabled={working}
            data-testid="archive-preview" aria-label={label("预览", "Preview") + " " + entry.name} onClick={() => preview(entry)}>{label("预览", "Preview")}</button>}
          <button type="button" className="taomni-btn" disabled={extractionBlocked} aria-label={label("解压", "Extract") + " " + entry.name}
            data-testid="archive-extract-entry" onClick={(event) => extract(event.currentTarget, false, entry)}>{label("解压…", "Extract…")}</button>
        </>}</td>
      </tr>)}</tbody></table>
      {!matching.length && <p role="status">{filter ? label("没有匹配条目", "No matching entries") : label("空压缩包", "Empty archive")}</p>}
    </div>}
    {matching.length > PAGE_SIZE && <footer>
      <button type="button" className="taomni-btn" disabled={page === 0} onClick={() => setPage(page - 1)}>{label("上一页", "Previous page")}</button>
      <span>{page + 1} / {Math.ceil(matching.length / PAGE_SIZE)}</span>
      <button type="button" className="taomni-btn" disabled={(page + 1) * PAGE_SIZE >= matching.length} onClick={() => setPage(page + 1)}>{label("下一页", "Next page")}</button>
    </footer>}
  </section>;
}
