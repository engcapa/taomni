import { PdfAnnotationList } from "./PdfAnnotationList.jsx";

const { React } = globalThis.__taomniHost;
const { useId, useLayoutEffect, useRef } = React;

export function PdfEditPanel({
  draft, pdf, sourceNumber, page, count, onPageAction, annotations, tool, onTool, note, onNote,
  onUndo, onClose, label, source, active,
}) {
  const heading = useId();
  const panel = useRef(null);
  useLayoutEffect(() => {
    if (active) panel.current?.focus();
  }, [active]);
  const locked = draft.saving || !draft.canEditPages;
  const save = () => { void draft.save().catch(() => {}); };
  return <section ref={panel} tabIndex={-1} aria-labelledby={heading} className="taoffice-pdf-form taoffice-pdf-edit"
    data-testid="taoffice-pdf-edit" onKeyDown={(event) => {
      if (!active || event.nativeEvent.isComposing || event.defaultPrevented) return;
      const mod = source.platform === "macos" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (mod && event.key === "s" && !event.shiftKey && !event.altKey && draft.dirty) {
        event.preventDefault();
        event.stopPropagation();
        save();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }}>
    <div className="taoffice-pdf-form-actions">
      <h3 id={heading}>{label("页面与批注", "Pages and annotations")}</h3>
      <button type="button" className="taomni-btn" data-testid="taoffice-pdf-edit-save" data-variant="primary"
        disabled={!draft.dirty || draft.saving} aria-busy={draft.saving} onClick={save}>
        {label("保存副本…", "Save a copy…")}
      </button>
      <button type="button" className="taomni-btn" data-testid="taoffice-pdf-edit-close" onClick={onClose}>
        {label("关闭编辑面板", "Close editing panel")}
      </button>
    </div>
    <div className="taoffice-pdf-form-actions" aria-label={label("当前页", "Current page")}>
      <button type="button" className="taomni-btn" data-testid="taoffice-pdf-edit-rotate" disabled={locked}
        onClick={() => onPageAction("rotate")}>{label("旋转页面", "Rotate page")}</button>
      <button type="button" className="taomni-btn" data-testid="taoffice-pdf-edit-earlier" disabled={locked || page <= 1}
        onClick={() => onPageAction("earlier")}>{label("向前移动", "Move earlier")}</button>
      <button type="button" className="taomni-btn" data-testid="taoffice-pdf-edit-later" disabled={locked || page >= count}
        onClick={() => onPageAction("later")}>{label("向后移动", "Move later")}</button>
      <button type="button" className="taomni-btn" data-testid="taoffice-pdf-edit-remove" disabled={locked || count <= 1}
        onClick={() => onPageAction("remove")}>{label("移除当前页", "Remove page")}</button>
    </div>
    <div className="taoffice-pdf-form-actions">
      <label className="taoffice-pdf-edit-choice">
        {label("批注工具", "Annotation tool")}
        <select className="taomni-input" data-testid="taoffice-pdf-edit-tool" value={tool}
          onChange={(event) => onTool(event.currentTarget.value)} disabled={locked}>
          <option value="">{label("选择文本", "Select text")}</option>
          <option value="highlight">{label("高亮区域", "Highlight area")}</option>
          <option value="box">{label("方框", "Rectangle")}</option>
          <option value="ink">{label("墨迹", "Ink")}</option>
          <option value="note">{label("便笺", "Note")}</option>
        </select>
      </label>
      {tool === "note" && <input className="taomni-input" data-testid="taoffice-pdf-edit-note"
        aria-label={label("便笺内容", "Note text")} placeholder={label("便笺内容", "Note text")}
        maxLength={1000} value={note} disabled={locked} onChange={(event) => onNote(event.currentTarget.value)} />}
      <button type="button" className="taomni-btn" data-testid="taoffice-pdf-edit-undo" disabled={locked || !annotations.length}
        onClick={onUndo}>{label("撤销此页最近的批注", "Undo last annotation on this page")}</button>
    </div>
    <PdfAnnotationList pdf={pdf} number={sourceNumber} annotations={annotations} label={label} />
    {draft.status && <p role="status" data-testid="taoffice-pdf-edit-output">{draft.status}</p>}
    {draft.error && <p role="alert" className="taoffice-pdf-error">{draft.error}</p>}
  </section>;
}
