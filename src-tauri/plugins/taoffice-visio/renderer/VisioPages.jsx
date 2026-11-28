import { Button } from "../../../crates/taomni-plugin-api/frontend/ui/Button";
import { usePendingAction } from "../../../crates/taomni-plugin-api/frontend/ui/usePendingAction";
import { composing, VisioFind } from "./VisioFind.jsx";

import { VisioShapes } from "./VisioShapes.jsx";
import { decodeVisio } from "./visioDocument.js";
import { saveVisioCopy } from "./visioPackage.js";
import { exportVisioPdf } from "./visioPdf.js";

const { React, formatShortcutDisplay } = globalThis.__taomniHost;
const { useEffect, useLayoutEffect, useRef, useState } = React;
const minZoom = 0.25;
const maxZoom = 4;

export function VisioPages({ initialPages, diagram, source, active, label, openSystem }) {
  const [previewEdits, setPreviewEdits] = useState(null);
  const [preview, setPreview] = useState(null);
  const pages = previewEdits?.size && preview?.pages ? preview.pages : initialPages;
  const pending = Boolean(previewEdits?.size) && preview?.edits !== previewEdits;
  useEffect(() => {
    if (!previewEdits?.size) {
      setPreview(null);
      return;
    }
    const controller = new AbortController();
    async function refresh() {
      const bytes = saveVisioCopy(diagram, previewEdits);
      const updated = await decodeVisio(bytes.buffer, false, controller.signal);
      if (!controller.signal.aborted) setPreview({ edits: previewEdits, pages: updated });
    }
    const timeout = setTimeout(() => {
      void refresh().catch(() => {
        if (!controller.signal.aborted) setPreview({ edits: previewEdits, error: true });
      });
    }, 250);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [diagram, previewEdits]);
  const [pageIndex, setPage] = useState(0);
  const [zoom, setZoom] = useState(null);
  const [fit, setFit] = useState(1);
  const [search, setSearch] = useState(false);
  const [exportStatus, setExportStatus] = useState(null);
  const viewport = useRef(null);
  const searchOrigin = useRef(null);
  const canvas = useRef(null);
  const page = pages[pageIndex];
  const scale = zoom ?? fit;
  const isMac = source.platform === "macos";
  const canExport = extension => source.saveCopy && source.copyExtensions?.includes(extension);
  const findName = label("查找文字…", "Find text…");
  const findShortcut = formatShortcutDisplay?.("Mod+F", isMac);
  const pageName = page.name || label(`第 ${pageIndex + 1} 页`, `Page ${pageIndex + 1}`);
  const exportRequest = useRef(null);
  const exportTask = usePendingAction(async () => {
    const { extension } = exportRequest.current;
    setExportStatus(null);
    try {
      const bytes = extension === "pdf" ? await exportVisioPdf(page) : new TextEncoder().encode(page.svg);
      const path = await source.saveCopy(bytes, { extension });
      if (path) setExportStatus({ extension, path });
    } catch (error) {
      setExportStatus({ extension, error: error.message ?? String(error) });
    }
  });
  const exportIneligible = Boolean(pending || (previewEdits?.size && preview?.error));
  async function requestExport(extension, trigger) {
    if (exportRequest.current || exportIneligible) return;
    exportRequest.current = { extension };
    try {
      await exportTask.run();
    } finally {
      exportRequest.current = null;
      requestAnimationFrame(() => {
        if (trigger.isConnected && trigger.ownerDocument.activeElement === trigger.ownerDocument.body) trigger.focus();
      });
    }
  }

  useLayoutEffect(() => {
    const view = viewport.current;
    if (!view) return;
    const size = () => {
      const width = view.clientWidth - 32;
      const height = view.clientHeight - 32;
      if (width > 0 && height > 0) setFit(Math.min(1, width / page.width, height / page.height));
    };
    size();
    const observer = new ResizeObserver(size);
    observer.observe(view);
    return () => observer.disconnect();
  }, [page]);

  useLayoutEffect(() => {
    viewport.current?.scrollTo(0, 0);
  }, [pageIndex, zoom]);

  function toggleFind(origin) {
    if (search) {
      setSearch(false);
      searchOrigin.current?.focus();
    } else {
      searchOrigin.current = origin;
      setSearch(true);
    }
  }

  function onViewportKey(event) {
    if (!active || event.defaultPrevented || composing(event) || event.altKey
      || event.shiftKey || event.getModifierState("AltGraph")) return;
    const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (mod && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopPropagation();
      if (!search) toggleFind(event.currentTarget);
      else canvas.current?.querySelector('input[type="search"]')?.focus();
    }
  }

  function changeZoom(direction) {
    setZoom(Math.min(maxZoom, Math.max(minZoom, Math.round(scale * 4 + direction) / 4)));
  }

  return <>
    <VisioShapes diagram={diagram} pageIndex={pageIndex} label={label} source={source}
      active={active} onPreview={setPreviewEdits} />
    {pending ? <p className="taoffice-visio-status" role="status">{label("正在更新预览…", "Updating preview…")}</p>
      : preview?.error && <p className="taoffice-visio-status" role="alert">
        {label("无法预览编辑后的图形，当前显示原图。", "Could not preview the edits. Showing the original diagram.")}
      </p>}
    <div className="taoffice-visio-toolbar" role="group" aria-label={label("Visio 工具栏", "Visio controls")}>
      <Button data-testid="taoffice-visio-previous" disabled={pageIndex === 0} onClick={() => setPage(pageIndex - 1)}>
        {label("上一页", "Previous page")}
      </Button>
      <span role="status" data-testid="taoffice-visio-page-name">
        {pageName} · {pageIndex + 1}/{pages.length}
      </span>
      <Button data-testid="taoffice-visio-next" disabled={pageIndex === pages.length - 1} onClick={() => setPage(pageIndex + 1)}>
        {label("下一页", "Next page")}
      </Button>
      <Button data-testid="taoffice-visio-zoom-out" disabled={zoom !== null && scale === minZoom}
        onClick={() => changeZoom(-1)}>{label("缩小", "Zoom out")}</Button>
      <span role="status" className="taoffice-visio-zoom" data-testid="taoffice-visio-zoom">{Math.round(scale * 100)}%</span>
      <Button data-testid="taoffice-visio-zoom-in" disabled={zoom !== null && scale === maxZoom}
        onClick={() => changeZoom(1)}>{label("放大", "Zoom in")}</Button>
      <Button data-testid="taoffice-visio-fit" aria-pressed={zoom === null} onClick={() => setZoom(null)}>
        {label("适应页面", "Fit page")}
      </Button>
      <Button data-testid="taoffice-visio-find" aria-expanded={search} aria-keyshortcuts={isMac ? "Meta+F" : "Control+F"}
        data-taomni-tooltip={findShortcut ? `${findName} (${findShortcut})` : findName}
        onClick={(event) => toggleFind(event.currentTarget)}>{findName}</Button>
      {openSystem}
      {canExport("svg") && <Button data-testid="taoffice-visio-export" variant="primary" disabled={exportIneligible || exportTask.busy}
        busy={exportTask.busy && exportRequest.current?.extension === "svg"}
        onClick={event => requestExport("svg", event.currentTarget)}>{label("导出此页为 SVG…", "Export page as SVG…")}</Button>}
      {canExport("pdf") && <Button data-testid="taoffice-visio-export-pdf" disabled={exportIneligible || exportTask.busy}
        busy={exportTask.busy && exportRequest.current?.extension === "pdf"}
        onClick={event => requestExport("pdf", event.currentTarget)}>{label("导出此页为 PDF…", "Export page as PDF…")}</Button>}
    </div>
    <div ref={canvas}>
      {search && <VisioFind pages={pages} setPage={setPage} close={() => toggleFind(null)} label={label} />}
    </div>
    {exportTask.busy && <p className="taoffice-visio-status" role="status" data-testid="taoffice-visio-export-pending">
      {label("正在导出此页。", "Exporting this page.")}
    </p>}
    {exportStatus?.path && <p className="taoffice-visio-status" role="status" data-testid="taoffice-visio-export-status">
      {label(`已导出 ${exportStatus.extension.toUpperCase()}。`, `${exportStatus.extension.toUpperCase()} exported.`)} {exportStatus.path}
    </p>}
    {exportStatus?.error && <p className="taoffice-visio-status" role="alert" data-testid="taoffice-visio-export-error">
      {label(`无法导出 ${exportStatus.extension.toUpperCase()}。`, `Could not export the ${exportStatus.extension.toUpperCase()}.`)}{" "}
      {exportStatus.error === "pdf-limits" ? label("页面过大。可导出 SVG 保留全图。",
        "The page exceeds the PDF size limit. Export as SVG to keep the full diagram.")
        : exportStatus.error === "pdf-render" ? label("无法绘制此页，请重试。", "Could not render this page. Try again.")
        : exportStatus.error}
    </p>}
    <div ref={viewport} tabIndex={0} className="taoffice-visio-viewport" data-testid="taoffice-visio-viewport"
      aria-label={label("Visio 页面", "Visio page")} onKeyDown={onViewportKey}>
      <VisioPage key={pageIndex} page={page} index={pageIndex} name={pageName} scale={scale} label={label} />
    </div>
    <p className="taoffice-visio-note" data-testid="taoffice-visio-fidelity">
      {label("预览可能省略部分 Visio 主题、公式和内嵌对象。请在系统应用中核对原图。",
        "The preview may omit some Visio themes, formulas, and embedded objects. Open the diagram in the system app to check the original.")}
    </p>
  </>;
}

function VisioPage({ page, index, name, scale, label }) {
  const [url, setUrl] = useState(null);
  const [rendered, setRendered] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    const pageUrl = URL.createObjectURL(new Blob([page.svg], { type: "image/svg+xml" }));
    setRendered(false);
    setError(false);
    setUrl(pageUrl);
    return () => URL.revokeObjectURL(pageUrl);
  }, [page]);
  return url && (error
    ? <p role="alert">{label("无法显示此页。", "Could not display this page.")}</p>
    : <img className="taoffice-visio-image" data-testid="taoffice-visio-page" data-page={index + 1}
      data-rendered={rendered} src={url} alt={name} draggable={false}
      width={Math.round(page.width * scale)} height={Math.round(page.height * scale)}
      onLoad={() => setRendered(true)} onError={() => setError(true)} />);
}
