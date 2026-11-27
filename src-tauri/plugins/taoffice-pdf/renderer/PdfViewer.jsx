import { openPdf } from "./pdfDocument.js";
import { MAX_PAGE_SCALE, MIN_PAGE_SCALE, pageNumber, stepPageScale } from "./pdfGeometry.js";
import { PdfPage } from "./PdfPage.jsx";
import { PdfOutline, PdfSearch } from "./PdfNavigation.jsx";
import styles from "./pdfViewer.css?inline";

const { React, i18n } = globalThis.__taomniHost;
const { useEffect, useRef, useState } = React;

export default function PdfViewer({ document: source, active }) {
  const { locale } = i18n.useLocale();
  const label = (zh, en) => locale === "zh-CN" ? zh : en;
  const [pdf, setPdf] = useState(null);
  const [revision, retry] = useState(0);
  const [failure, setFailure] = useState("");
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [pageError, setPageError] = useState(false);
  const [zoom, setZoom] = useState(null);
  const [scale, setScale] = useState(null);
  const [rotation, setRotation] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [navigation, setNavigation] = useState(null);
  const [highlight, setHighlight] = useState("");
  const viewport = useRef(null);
  const searchInput = useRef(null);
  const searchReturnFocus = useRef(null);
  const outlineButton = useRef(null);
  const isMac = source.platform === "macos";
  const modifier = isMac ? "⌘" : "Ctrl";

  useEffect(() => {
    let alive = true;
    let task;
    setPdf(null);
    setFailure("");
    async function load() {
      const bytes = await (await source.read()).arrayBuffer();
      if (!alive) return;
      task = openPdf(new Uint8Array(bytes));
      const opened = await task.promise;
      if (alive) setPdf(opened);
    }
    void load().catch((error) => { if (alive) setFailure(String(error)); });
    return () => {
      alive = false;
      void task?.destroy().catch(() => {});
    };
  }, [source, revision]);

  useEffect(() => {
    const node = viewport.current;
    const resize = new ResizeObserver(([entry]) => setViewportWidth(Math.round(entry.contentRect.width)));
    resize.observe(node);
    return () => resize.disconnect();
  }, []);

  function go(number) {
    const clamped = Math.max(1, Math.min(number, pdf?.numPages ?? 1));
    setPage(clamped);
    setPageInput(String(clamped));
    setPageError(false);
    viewport.current?.scrollTo(0, 0);
  }
  function changeZoom(step) {
    if (scale !== null) setZoom(stepPageScale(zoom ?? scale, step));
  }
  function changeNavigation(next) {
    setHighlight("");
    setNavigation(next === navigation ? null : next);
  }
  function openSearch(origin) {
    searchReturnFocus.current = origin;
    if (navigation === "search") searchInput.current?.focus();
    else changeNavigation("search");
  }
  function closeSearch() {
    changeNavigation(null);
    searchReturnFocus.current?.focus();
  }
  function onViewportKey(event) {
    if (!active || !pdf || event.defaultPrevented || event.nativeEvent.isComposing
      || event.altKey || event.getModifierState("AltGraph")) return;
    const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (!mod) return;
    if (event.key === "f" && !event.shiftKey) openSearch(event.currentTarget);
    else if (!scale) return;
    else if (event.key === "+" || event.key === "=" || event.code === "NumpadAdd") changeZoom(1);
    else if (event.key === "-" || event.code === "NumpadSubtract") changeZoom(-1);
    else if (event.key === "0" || event.code === "Numpad0") setZoom(null);
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  const currentPage = Math.min(page, pdf?.numPages ?? 1);
  const pageLabel = label("页码", "Page number");
  return <div className="taoffice-pdf" data-testid="taoffice-pdf">
    <style>{styles}</style>
    <div className="taoffice-pdf-toolbar" role="group" aria-label={label("PDF 工具栏", "PDF controls")}>
      <button type="button" className="taomni-btn" data-testid="taoffice-pdf-previous"
        disabled={!pdf || currentPage <= 1} onClick={() => go(currentPage - 1)}>{label("上一页", "Previous page")}</button>
      <form onSubmit={(event) => {
        event.preventDefault();
        const number = pageNumber(pageInput, pdf?.numPages ?? 0);
        if (number === null) setPageError(true);
        else go(number);
      }}>
        <input className="taomni-input" data-testid="taoffice-pdf-page-number" aria-label={pageLabel}
          aria-invalid={pageError} inputMode="numeric" value={pageInput} disabled={!pdf}
          onChange={(event) => { setPageInput(event.target.value); setPageError(false); }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && pageInput !== String(currentPage)) {
              event.stopPropagation();
              go(currentPage);
            }
          }} />
        <span data-testid="taoffice-pdf-page-count" className="tabular-nums">/ {pdf?.numPages ?? "—"}</span>
      </form>
      <button type="button" className="taomni-btn" data-testid="taoffice-pdf-next"
        disabled={!pdf || currentPage >= pdf.numPages} onClick={() => go(currentPage + 1)}>{label("下一页", "Next page")}</button>
      <button type="button" className="taomni-btn" data-testid="taoffice-pdf-zoom-out"
        title={`${label("缩小", "Zoom out")} (${modifier}+-)`}
        disabled={!pdf || scale === null || (zoom ?? scale) <= MIN_PAGE_SCALE} onClick={() => changeZoom(-1)}>{label("缩小", "Zoom out")}</button>
      <button type="button" className="taomni-btn" data-testid="taoffice-pdf-zoom-in"
        title={`${label("放大", "Zoom in")} (${modifier}+=)`}
        disabled={!pdf || scale === null || (zoom ?? scale) >= MAX_PAGE_SCALE} onClick={() => changeZoom(1)}>{label("放大", "Zoom in")}</button>
      <button type="button" className="taomni-btn" data-testid="taoffice-pdf-fit"
        title={`${label("适应宽度", "Fit width")} (${modifier}+0)`}
        disabled={!pdf} aria-pressed={zoom === null} onClick={() => setZoom(null)}>{label("适应宽度", "Fit width")}</button>
      <button type="button" className="taomni-btn" data-testid="taoffice-pdf-rotate"
        disabled={!pdf} onClick={() => setRotation((value) => (value + 90) % 360)}>{label("向右旋转", "Rotate right")}</button>
      <button type="button" className="taomni-btn" data-testid="taoffice-pdf-find"
        title={`${label("查找文字", "Find text")} (${modifier}+F)`}
        disabled={!pdf} aria-expanded={navigation === "search"}
        onClick={(event) => navigation === "search" ? closeSearch() : openSearch(event.currentTarget)}>
        {label("查找文字", "Find text")}
      </button>
      <button ref={outlineButton} type="button" className="taomni-btn" data-testid="taoffice-pdf-outline-toggle"
        disabled={!pdf} aria-expanded={navigation === "outline"} onClick={() => changeNavigation("outline")}>
        {label("大纲", "Outline")}
      </button>
    </div>
    {pageError && <p role="alert" data-testid="taoffice-pdf-page-error">
      {label("请输入文档范围内的页码。", "Enter a page number within the document.")}</p>}
    {pdf && navigation === "search" && <PdfSearch pdf={pdf} label={label} input={searchInput}
      onMatch={(number, query) => { setHighlight(query); if (number) go(number); }}
      onClose={closeSearch} />}
    {pdf && navigation === "outline" && <PdfOutline pdf={pdf} label={label} onGo={go}
      onClose={() => { changeNavigation(null); outlineButton.current?.focus(); }} />}
    <div className="taoffice-pdf-viewport" ref={viewport} tabIndex={0} aria-label={source.name}
      data-testid="taoffice-pdf-viewport" onKeyDown={onViewportKey}>
      {failure && <div className="taoffice-pdf-error">
        <p role="alert" data-testid="taoffice-pdf-error">{label("无法读取 PDF。", "Cannot read PDF.")} {failure}</p>
        <button type="button" className="taomni-btn" data-testid="taoffice-pdf-retry"
          onClick={() => { go(1); retry((value) => value + 1); }}>{label("重试", "Retry")}</button>
      </div>}
      {!pdf && !failure && <p role="status">{label("正在读取 PDF…", "Reading PDF…")}</p>}
      {pdf && viewportWidth > 0 && <PdfPage
        key={currentPage + "/" + (zoom ?? viewportWidth + "fit") + "/" + rotation}
        pdf={pdf} number={currentPage} zoom={zoom} rotation={rotation} highlight={highlight} onScale={setScale}
        viewportWidth={zoom ? 0 : viewportWidth} label={label} />}
    </div>
  </div>;
}
