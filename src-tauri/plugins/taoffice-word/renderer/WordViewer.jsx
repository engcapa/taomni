import { docxPreviewBytes, MAX_DOCX_BYTES, openDocx, saveDocxCopy } from "./docxPackage.js";
import { MAX_PARAGRAPH_LENGTH } from "./wordXml.js";
import { renderWordPreview } from "./wordPreview.js";
import { useDocumentDraft } from "../../../crates/taomni-plugin-api/frontend/documentDraft.js";
import styles from "./wordViewer.css?inline";

const { React, i18n } = globalThis.__taomniHost;
const { useEffect, useRef, useState } = React;

export default function WordViewer({ document: source, active }) {
  const { locale } = i18n.useLocale();
  const label = (zh, en) => locale === "zh-CN" ? zh : en;
  const [loaded, setLoaded] = useState(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setLoaded(null);
    setError("");
    async function load() {
      const file = await source.read();
      if (!current) return;
      if (file.size > MAX_DOCX_BYTES) throw new Error(label("DOCX 预览上限为 16 MiB。", "DOCX preview is limited to 16 MiB."));
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!current) return;
      const document = openDocx(bytes);
      const preview = await renderWordPreview(docxPreviewBytes(document, new Map()));
      if (current) setLoaded({ source, document, preview });
    }
    void load().catch((failure) => { if (current) setError(String(failure)); });
    return () => { current = false; };
  }, [source, attempt]);

  return <section className="taoffice-word" aria-label={source.name} data-testid="taoffice-word">
    <style>{styles}</style>
    {loaded?.source === source
      ? <LoadedWord source={source} document={loaded.document} preview={loaded.preview} active={active} label={label} />
      : error ? <div className="taoffice-word-feedback" role="alert" data-testid="taoffice-word-error">
        <p>{error}</p>
        <button type="button" className="taomni-btn" onClick={() => setAttempt((value) => value + 1)}>{label("重试", "Retry")}</button>
      </div> : <p className="taoffice-word-feedback" role="status">{label("正在打开 Word 文档…", "Opening Word document…")}</p>}
  </section>;
}

function LoadedWord({ source, document, preview: initialPreview, active, label }) {
  const [editMode, setEditMode] = useState(false);
  const [preview, setPreview] = useState(initialPreview);
  const [previewError, setPreviewError] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const toggle = useRef(null);
  const editor = useRef(null);
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
    if (!active || event.nativeEvent.isComposing) return;
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
        <button type="button" ref={toggle} className="taomni-btn" data-testid="taoffice-word-edit"
          onClick={() => editMode ? showPreview() : setEditMode(true)}>
          {editMode ? label("页面预览", "Page preview") : label("编辑段落", "Edit paragraphs")}
        </button>
        <button type="button" className="taomni-btn" data-variant="primary" data-testid="taoffice-word-save"
          disabled={!draft.dirty || draft.saving} aria-busy={draft.saving} onClick={save}>
          {draft.saving ? label("正在保存…", "Saving…") : label("保存副本", "Save a copy")}
        </button>
      </>}
    </div>
    {(draft.error || previewError) && <p className="taoffice-word-feedback" role="alert">{draft.error || previewError}</p>}
    {draft.output && <p className="taoffice-word-feedback" role="status" data-testid="taoffice-word-output">{draft.output}</p>}
    {!canEdit && !source.readOnly && <p className="taoffice-word-feedback" role="status">
      {label("此文档没有可编辑的普通文本段落。", "This document has no editable plain-text paragraphs.")}
    </p>}
    {editMode ? <div className="taoffice-word-paragraphs" aria-label={label("可编辑段落", "Editable paragraphs")}>
      <p>{label("可修改单一格式的正文段落。表格和页眉可在页面预览中查看。", "Edit body paragraphs with a single text format. See tables and headers in Page preview.")}</p>
      {document.paragraphs.map((paragraph, index) => <label key={paragraph.id}>
        <span>{label("段落", "Paragraph")} {index + 1}</span>
        <input type="text" ref={index === 0 ? editor : undefined} data-testid="taoffice-word-paragraph"
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
