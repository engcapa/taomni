import { openPdf } from "./pdfDocument.js";
import { pageNumber } from "./pdfGeometry.js";
import { PdfPage } from "./PdfPage.jsx";
import styles from "./pdfViewer.css?inline";

const { React, i18n } = globalThis.__taomniHost;
const { useEffect, useRef, useState } = React;
const zoomLevels = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export default function PdfViewer({ document: source }) {
  const { locale } = i18n.useLocale();
  const label = (zh, en) => locale === "zh-CN" ? zh : en;
  const [pdf, setPdf] = useState(null);
  const [revision, retry] = useState(0);
  const [failure, setFailure] = useState("");
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [pageError, setPageError] = useState(false);
  const [zoom, setZoom] = useState(null);
  const [rotation, setRotation] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const viewport = useRef(null);

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
    const index = zoomLevels.indexOf(zoom ?? 1);
    setZoom(zoomLevels[Math.max(0, Math.min(zoomLevels.length - 1, index + step))]);
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
        disabled={!pdf || zoom === zoomLevels[0]} onClick={() => changeZoom(-1)}>{label("缩小", "Zoom out")}</button>
      <button type="button" className="taomni-btn" data-testid="taoffice-pdf-zoom-in"
        disabled={!pdf || zoom === zoomLevels.at(-1)} onClick={() => changeZoom(1)}>{label("放大", "Zoom in")}</button>
      <button type="button" className="taomni-btn" data-testid="taoffice-pdf-fit"
        disabled={!pdf} aria-pressed={zoom === null} onClick={() => setZoom(null)}>{label("适应宽度", "Fit width")}</button>
      <button type="button" className="taomni-btn" data-testid="taoffice-pdf-rotate"
        disabled={!pdf} onClick={() => setRotation((value) => (value + 90) % 360)}>{label("向右旋转", "Rotate right")}</button>
    </div>
    {pageError && <p role="alert" data-testid="taoffice-pdf-page-error">
      {label("请输入文档范围内的页码。", "Enter a page number within the document.")}</p>}
    <div className="taoffice-pdf-viewport" ref={viewport} tabIndex={0} aria-label={source.name}>
      {failure && <div className="taoffice-pdf-error">
        <p role="alert" data-testid="taoffice-pdf-error">{label("无法读取 PDF。", "Cannot read PDF.")} {failure}</p>
        <button type="button" className="taomni-btn" data-testid="taoffice-pdf-retry"
          onClick={() => { go(1); retry((value) => value + 1); }}>{label("重试", "Retry")}</button>
      </div>}
      {!pdf && !failure && <p role="status">{label("正在读取 PDF…", "Reading PDF…")}</p>}
      {pdf && viewportWidth > 0 && <PdfPage
        key={currentPage + "/" + (zoom ?? viewportWidth + "fit") + "/" + rotation}
        pdf={pdf} number={currentPage} zoom={zoom} rotation={rotation} viewportWidth={zoom ? 0 : viewportWidth} label={label} />}
    </div>
  </div>;
}
