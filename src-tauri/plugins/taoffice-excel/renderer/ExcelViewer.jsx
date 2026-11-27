import { openWorkbook, ROWS, COLUMNS } from "./workbook.js";
import { Worksheet } from "./Worksheet.jsx";
import { useWorkbookEdits } from "./useWorkbookEdits.js";
import styles from "./workbook.css?inline";

const { React, i18n } = globalThis.__taomniHost;
const { useEffect, useId, useRef, useState } = React;
const ORIGIN = { row: 0, column: 0 };

export default function ExcelViewer({ document: source, active, api }) {
  const { locale } = i18n.useLocale();
  const label = (zh, en) => locale === "zh-CN" ? zh : en;
  const prefix = useId();
  const sheetButtons = useRef([]);
  const positions = useRef(new Map());
  const [retry, setRetry] = useState(0);
  const [book, setBook] = useState(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [cursor, setCursor] = useState(ORIGIN);
  const [range, setRange] = useState(null);
  const [failure, setFailure] = useState("");
  const editor = useWorkbookEdits(book, source, api);

  useEffect(() => {
    const id = crypto.randomUUID();
    const controller = new AbortController();
    const release = api.deferCleanup?.("workbook/close", { id });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      if (release) release();
      else void api.invoke("workbook/close", { id }).catch(() => {});
    };
    setBook(null);
    setRange(null);
    setFailure("");
    setSheetIndex(0);
    setCursor(ORIGIN);
    positions.current.clear();
    void openWorkbook(api, source, id, controller.signal).then(({ sheets }) => {
      if (!controller.signal.aborted) setBook({ id, sheets });
    }).catch((error) => {
      if (!controller.signal.aborted) setFailure(error.message ?? String(error));
      close();
    });
    return () => { controller.abort(); close(); };
  }, [api, source, retry]);

  const sheet = book?.sheets[sheetIndex];
  const row = Math.floor(cursor.row / ROWS) * ROWS;
  const column = Math.floor(cursor.column / COLUMNS) * COLUMNS;
  useEffect(() => {
    if (!book || !sheet) return;
    const controller = new AbortController();
    void api.invoke("workbook/sheet", { id: book.id, sheet, row, column }, { signal: controller.signal })
      .then((window) => { if (!controller.signal.aborted) setRange({ sheet, start: { row, column }, window }); })
      .catch((error) => { if (!controller.signal.aborted) setFailure(error.message ?? String(error)); });
    return () => controller.abort();
  }, [api, book, sheet, row, column]);

  function chooseSheet(index) {
    if (index === sheetIndex) return;
    positions.current.set(sheetIndex, cursor);
    setSheetIndex(index);
    setCursor(positions.current.get(index) ?? ORIGIN);
  }

  function onSheetKey(event, index) {
    if (event.nativeEvent.isComposing) return;
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const length = book.sheets.length;
    const next = delta ? (index + delta + length) % length : event.key === "Home" ? 0 : event.key === "End" ? length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    chooseSheet(next);
    sheetButtons.current[next]?.focus();
  }

  const visibleRange = range?.sheet === sheet ? range : null;
  const pending = !visibleRange || visibleRange.start.row !== row || visibleRange.start.column !== column;
  return <div className="taoffice-excel" data-testid="taoffice-excel" onKeyDown={(event) => {
    if (!active || !editor.dirty || event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
    const mod = source.platform === "macos" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (mod && event.key === "s" && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      void editor.save().catch(() => {});
    }
  }}>
    <style>{styles}</style>
    {failure ? <div className="taoffice-excel-feedback" role="alert" data-testid="taoffice-excel-error">
      <p>{label("无法打开工作簿。", "Could not open the workbook.")} {failure}</p>
      <button className="taomni-btn" type="button" onClick={() => setRetry((value) => value + 1)}>{label("重试", "Retry")}</button>
      <button className="taomni-btn" type="button" onClick={() => source.openSystem().catch(() => setFailure(label("请检查系统文件关联后重试。", "Check the system file association and retry.")))}>
        {label("用系统应用打开", "Open in system app")}
      </button>
    </div> : <>
      {book && <div className="taoffice-excel-sheets" role="tablist" aria-label={label("工作表", "Worksheets")}>
        {book.sheets.map((name, index) => <button key={name} id={`${prefix}-sheet-${index}`}
          ref={(node) => { sheetButtons.current[index] = node; }} role="tab" type="button" className="taomni-section-tab"
          tabIndex={sheetIndex === index ? 0 : -1} aria-controls={`${prefix}-worksheet`}
          aria-selected={sheetIndex === index} data-testid="taoffice-excel-sheet"
          onClick={() => chooseSheet(index)} onKeyDown={(event) => onSheetKey(event, index)}>{name}</button>)}
      </div>}
      {pending && <p className="taoffice-excel-feedback" role="status">{label("正在读取工作表…", "Reading worksheet…")}</p>}
      {book && <section id={`${prefix}-worksheet`} aria-labelledby={`${prefix}-sheet-${sheetIndex}`} role="tabpanel" className="taoffice-excel-panel">
        {visibleRange && <Worksheet key={sheet} range={visibleRange} cursor={cursor}
          move={setCursor} active={active} pending={pending} label={label} platform={source.platform} editor={editor} />}
      </section>}
      {editor.permitted && <div className="taoffice-excel-copy">
        <button type="button" className="taomni-btn" data-testid="taoffice-excel-save-copy"
          disabled={!editor.dirty || editor.saving} onClick={() => { void editor.save().catch(() => {}); }}>
          {label("保存副本…", "Save a copy…")}
        </button>
        {editor.saving ? <span role="status">{label("正在保存副本…", "Saving workbook copy…")}</span>
          : editor.edits.size > 0 && <span>{label("公式仍显示原工作簿的缓存结果。", "Formulas display cached results from the original workbook.")}</span>}
        {editor.output && <span role="status" data-testid="taoffice-excel-copy-output">{label("已保存副本", "Saved copy")} {editor.output}</span>}
        {editor.error && <span role="alert" data-testid="taoffice-excel-copy-error">{label("无法保存副本。", "Could not save the copy.")} {editor.error}</span>}
      </div>}
    </>}
  </div>;
}
