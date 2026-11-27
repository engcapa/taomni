import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { viewerReadText } from "../../lib/viewer";
import { openFile, fileExtension } from "../../lib/openFile";
import { parseDelimitedPrefix } from "../../lib/openFile/delimitedPreview";
import { observeElementOffsetClean } from "../../lib/virtualOffsetObserver";
import { basename } from "../../lib/sftp";
import type { FileViewerTabInfo } from "../../types";
import { useViewerLabels } from "./viewerLabels";
import "./delimitedDocument.css";

const MAX_ROWS = 1000;
const MAX_COLUMNS = 128;
const PREFIX_BYTES = 256 * 1024;

export function DelimitedDocumentPane({ viewer, active = true, host, workspaceId }: {
  viewer: FileViewerTabInfo; active?: boolean; host?: "explorer"; workspaceId?: string;
}) {
  const label = useViewerLabels();
  const [result, setResult] = useState<ReturnType<typeof parseDelimitedPrefix>>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const { path } = viewer;
  useEffect(() => {
    let current = true;
    setResult(undefined);
    setError("");
    void viewerReadText(path, PREFIX_BYTES).then(({ content, truncated }) => {
      if (current) setResult(parseDelimitedPrefix(content, MAX_ROWS, fileExtension(path) === "tsv" ? "\t" : ",", !truncated));
    }).catch((reason) => { if (current) setError(String(reason)); });
    return () => { current = false; };
  }, [path, revision]);
  const rows = result?.rows ?? [];
  const list = useVirtualizer({
    count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => 26,
    measureElement: (el) => el.getBoundingClientRect().height, overscan: 5,
    initialRect: { width: 800, height: 400 }, observeElementOffset: observeElementOffsetClean,
  });
  const visible = list.getVirtualItems();
  const end = visible.at(-1)?.end ?? 0;
  const clippedColumns = rows.some((row) => row.length > MAX_COLUMNS);
  return <section className="fv delimited-document" data-testid="file-viewer" data-kind="text" data-path={path} data-active={active}>
    <div className="fv-toolbar">
      <strong>{basename(path)}</strong>
      <span className="fv-spacer" />
      <button type="button" className="taomni-btn" data-testid="delimited-source" onClick={() => {
        void openFile(viewer, { context: "table-source", mode: "source", host, workspaceId }).catch((reason) => setError(String(reason)));
      }}>{label("查看源文件", "View source")}</button>
      <button type="button" className="taomni-btn" onClick={() => setRevision((value) => value + 1)}>
        {label("重新加载", "Reload")}
      </button>
    </div>
    {viewer.readOnlyReason && <p className="fv-banner info" data-testid="viewer-readonly">{viewer.readOnlyReason}</p>}
    {error ? <p role="alert" className="fv-banner warn">{error}</p> : !result
      ? <p role="status">{label("正在读取表格…", "Reading table…")}</p>
      : <>
        <p role="status" className="delimited-status">{result.truncated
          ? label(`预览前 ${rows.length} 行完整记录`, `Previewing the first ${rows.length} complete rows`)
          : label(`${rows.length} 行`, `${rows.length} rows`)}
          {clippedColumns && label(` · 仅显示前 ${MAX_COLUMNS} 列`, ` · Showing the first ${MAX_COLUMNS} columns`)}</p>
        <div className="delimited-scroll" ref={scroller} tabIndex={0} role="region" aria-label={label("表格预览", "Table preview")}>
          <table data-testid="delimited-table" aria-label={basename(path)} aria-rowcount={rows.length}>
            <tbody>
              <tr aria-hidden="true" style={{ height: visible[0]?.start ?? 0 }} />
              {visible.map(({ index, key }) => <tr key={key} data-index={index} ref={list.measureElement} aria-rowindex={index + 1}>
                <th scope="row">{index + 1}</th>
                {rows[index].slice(0, MAX_COLUMNS).map((cell, col) => <td key={col}>{cell}</td>)}
              </tr>)}
              <tr aria-hidden="true" style={{ height: Math.max(0, list.getTotalSize() - end) }} />
            </tbody>
          </table>
        </div>
      </>}
  </section>;
}
