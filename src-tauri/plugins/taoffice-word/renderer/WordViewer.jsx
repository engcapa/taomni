import { docxPreviewBytes, saveDocxCopy } from "./docxPackage.js";
import { MAX_PARAGRAPH_LENGTH } from "./wordXml.js";
import { renderWordPreview } from "./wordPreview.js";
import { useDocumentDraft } from "../../../crates/taomni-plugin-api/frontend/documentDraft.js";
import { Button } from "../../../crates/taomni-plugin-api/frontend/ui/Button";
import { useWordPreview } from "./useWordPreview.js";
import styles from "./wordViewer.css?inline";

const { React, i18n, icons } = globalThis.__taomniHost;
const { useEffect, useId, useRef, useState } = React;

export default function WordViewer({ document: source, active }) {
  const { locale } = i18n.useLocale();
  const label = (zh, en) => locale === "zh-CN" ? zh : en;
  const { state, legacy, retry, cancel } = useWordPreview(source);

  return <section className="taoffice-word" aria-label={source.name} data-testid="taoffice-word">
    <style>{styles}</style>
    {state.phase === "ready"
      ? <LoadedWord source={source} document={state.document} preview={state.preview}
          active={active} label={label} legacy={legacy} />
      : <WordPreviewStatus state={state} legacy={legacy} label={label} retry={retry} cancel={cancel} />}
  </section>;
}

function WordPreviewStatus({ state, legacy, label, retry, cancel }) {
  const [copiedError, setCopiedError] = useState(null);
  if (state.phase === "converting") {
    const progress = label("正在转换 Word 文档…", "Converting Word document…");
    return <div className="taoffice-word-loading">
      <span role="status"><icons.Loader2 aria-hidden="true" className="size-3.5 animate-spin" />{progress}</span>
      <Button onClick={cancel} data-testid="taoffice-word-conversion-cancel">{label("取消转换", "Cancel conversion")}</Button>
    </div>;
  }
  if (state.phase === "opening") {
    return <p className="taoffice-word-feedback" role="status">{label("正在打开 Word 文档…", "Opening Word document…")}</p>;
  }
  const cancelled = state.phase === "cancelled";
  const failure = state.error?.message;
  const errors = {
    limits: label("此 Word 文档超出预览限制。请用办公软件打开。",
      "This Word document exceeds the preview limits. Open it in your office app."),
    engine: label("无法加载 Word 转换器。请重试。",
      "Could not load the Word converter. Retry the conversion."),
    format: label("无法转换此 Word 文档。请确认文件完整且没有密码保护，或用办公软件另存为 DOCX。",
      "Could not convert this Word document. Check for damage or password protection, or save it as DOCX in your office app."),
  };
  const message = cancelled ? label("已取消 Word 文档转换。", "Word conversion cancelled.")
    : errors[failure] ?? (legacy ? errors.format : String(state.error));
  return <div className="taoffice-word-feedback">
    <p role={cancelled ? "status" : "alert"} data-testid="taoffice-word-error">{message}</p>
    <div className="taoffice-word-loading">
      <Button onClick={retry} data-testid="taoffice-word-retry">{label("重试", "Retry")}</Button>
      {!cancelled && legacy && <Button onClick={() => {
        void navigator.clipboard.writeText(message).then(
          () => setCopiedError({ state, success: true }),
          () => setCopiedError({ state, success: false }),
        );
      }}>{label("复制错误详情", "Copy error details")}</Button>}
    </div>
    {copiedError?.state === state && <p role={copiedError.success ? "status" : "alert"}>
      {copiedError.success ? label("已复制错误详情。", "Error details copied.")
        : label("无法访问剪贴板。可选中上方错误详情复制。", "Clipboard unavailable. Select the error message to copy it.")}
    </p>}
  </div>;
}

function LoadedWord({ source, document, preview: initialPreview, active, label, legacy }) {
  const [editMode, setEditMode] = useState(false);
  const [preview, setPreview] = useState(initialPreview);
  const [previewError, setPreviewError] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const toggle = useRef(null);
  const editor = useRef(null);
  const conversionNote = useId();
  const draft = useDocumentDraft(source, (edits) => saveDocxCopy(document, edits));
  const canEdit = !!source.saveCopy && document.paragraphs.length > 0;

  useEffect(() => {
    if (editMode) editor.current?.focus();
  }, [editMode]);

  useEffect(() => {
    if (editMode) return;
    if (!draft.edits.size) {
      setPreview(initialPreview);
      setPreviewError("");
      setPreviewing(false);
      return;
    }
    let current = true;
    setPreviewing(true);
    setPreviewError("");
    void Promise.resolve()
      .then(() => renderWordPreview(docxPreviewBytes(document, draft.edits)))
      .then((updated) => { if (current) setPreview(updated); })
      .catch((failure) => { if (current) setPreviewError(String(failure)); })
      .finally(() => { if (current) setPreviewing(false); });
    return () => { current = false; };
  }, [document, draft.edits, editMode, initialPreview]);

  function save() { void draft.save().catch(() => {}); }
  function showPreview() {
    setEditMode(false);
    toggle.current?.focus();
  }
  return <div className="taoffice-word-content" onKeyDown={(event) => {
    if (!active || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (editMode && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      showPreview();
    } else if ((source.platform === "macos" ? event.metaKey : event.ctrlKey)
      && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s" && draft.dirty) {
      event.preventDefault();
      event.stopPropagation();
      save();
    }
  }}>
    <div className="taoffice-word-toolbar">
      <span className="taoffice-word-name">{source.name}</span>
      {canEdit && <>
        <Button ref={toggle} data-testid="taoffice-word-edit"
          onClick={() => editMode ? showPreview() : setEditMode(true)}>
          {editMode ? label("页面预览", "Page preview") : label("编辑段落", "Edit paragraphs")}
        </Button>
        <Button variant="primary" data-testid="taoffice-word-save" disabled={!draft.dirty}
          busy={draft.saving} aria-describedby={legacy ? conversionNote : undefined} onClick={save}>
          {legacy ? label("保存 DOCX 副本…", "Save DOCX copy…") : label("保存副本", "Save a copy")}
        </Button>
      </>}
    </div>
    {legacy && <p id={conversionNote} className="taoffice-word-conversion" data-testid="taoffice-word-conversion">
      {label("分页、文本框和复杂布局可能在转换后变化。可将编辑结果保存为 DOCX 副本。",
        "Page breaks, text boxes, and complex layouts may change during conversion. Edits can be saved as a DOCX copy.")}
    </p>}
    {(draft.error || previewError) && <p className="taoffice-word-feedback" role="alert">{draft.error || previewError}</p>}
    {draft.output && <p className="taoffice-word-feedback" role="status" data-testid="taoffice-word-output">{draft.output}</p>}
    {!canEdit && !source.readOnly && <p className="taoffice-word-feedback" role="status">
      {label("此文档没有可编辑的段落。", "This document has no editable paragraphs.")}
    </p>}
    {editMode ? <div className="taoffice-word-paragraphs" aria-label={label("可编辑段落", "Editable paragraphs")}>
      {document.paragraphs.map((paragraph, index) => <label key={paragraph.id}>
        <span>{paragraph.tableDepth ? label("表格单元格段落", "Table cell paragraph") : label("正文段落", "Body paragraph")} {index + 1}</span>
        <input type="text" ref={index === 0 ? editor : undefined} data-testid="taoffice-word-paragraph"
          data-location={paragraph.tableDepth ? "table" : "body"}
          className="taomni-input" maxLength={MAX_PARAGRAPH_LENGTH} disabled={draft.saving}
          value={draft.edits.get(paragraph.id) ?? paragraph.text}
          onChange={(event) => draft.edit(paragraph.id, event.target.value, paragraph.text)} />
      </label>)}
    </div> : <>
      {previewing && <p className="taoffice-word-feedback" role="status">{label("正在更新预览…", "Updating preview…")}</p>}
      <iframe className="taoffice-word-preview" data-testid="taoffice-word-preview" sandbox="allow-same-origin"
        title={label("Word 页面预览", "Word page preview")} srcDoc={preview} />
    </>}
  </div>;
}
