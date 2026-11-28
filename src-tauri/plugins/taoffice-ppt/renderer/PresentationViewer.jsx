import { Button } from "../../../crates/taomni-plugin-api/frontend/ui/Button.tsx";
import { useDocumentDraft } from "../../../crates/taomni-plugin-api/frontend/documentDraft.js";
import { MAX_PRESENTATION_BYTES, openPresentation, presentationPreviewBytes, savePresentationCopy } from "./presentationPackage.js";
import { convertLegacyPresentation } from "./legacyPresentation.js";
import { MAX_SLIDE_TEXT } from "./slideText.js";
import { NewPresentation } from "./NewPresentation.jsx";
import { SlidePreview } from "./SlidePreview.jsx";
import styles from "./presentationViewer.css?inline";

const { React, i18n } = globalThis.__taomniHost;
const { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } = React;

export default function PresentationViewer({ document: source, active }) {
  const { locale } = i18n.useLocale();
  const label = (zh, en) => locale === "zh-CN" ? zh : en;
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState(null);

  const conversion = useRef(null);
  const legacy = source.extension === "ppt" || source.extension === "odp";
  useEffect(() => {
    const task = new AbortController();
    conversion.current = task;
    const update = (state) => {
      if (!task.signal.aborted) setLoad({ source, attempt, ...state });
    };
    async function open() {
      const file = await source.read();
      task.signal.throwIfAborted();
      if (file.size > MAX_PRESENTATION_BYTES) throw new Error("limits");
      const bytes = new Uint8Array(await file.arrayBuffer());
      task.signal.throwIfAborted();
      if (legacy) update({ converting: true });
      const data = legacy ? await convertLegacyPresentation(bytes, source.extension, task.signal) : bytes;
      task.signal.throwIfAborted();
      update({ presentation: openPresentation(data) });
    }
    void open().catch((error) => update({ error }));
    return () => {
      task.abort();
      if (conversion.current === task) conversion.current = null;
    };
  }, [source, attempt, legacy]);

  function cancel() {
    conversion.current?.abort();
    setLoad({ source, attempt, cancelled: true });
  }

  const outcome = load?.source === source && load.attempt === attempt ? load : null;
  return <section className="taoffice-ppt" aria-label={source.name} data-testid="taoffice-ppt">
    <style>{styles}</style>
    {outcome?.presentation ? <Presentation source={source} presentation={outcome.presentation} active={active} label={label} legacy={legacy} />
      : outcome?.converting ? <div className="taoffice-ppt-feedback">
        <p role="status">{label("正在转换演示文稿…", "Converting presentation…")}</p>
        <Button data-testid="taoffice-ppt-conversion-cancel" onClick={cancel}>{label("取消转换", "Cancel conversion")}</Button>
      </div> : outcome ? <div className="taoffice-ppt-feedback">
        <p role={outcome.cancelled ? "status" : "alert"} data-testid="taoffice-ppt-error">
          {outcome.cancelled ? label("已取消转换。", "Conversion cancelled.")
            : outcome.error?.message === "limits" ? label("演示文稿超出预览限制。", "This presentation exceeds the preview limits.")
            : outcome.error?.message === "engine" ? label("无法加载转换器，请重试。", "Could not load the presentation converter. Retry the conversion.")
            : legacy ? label("无法转换演示文稿。请确认文件完整且没有密码保护，或在办公软件中另存为 PPTX。",
              "Could not convert the presentation. Check for damage or password protection, or save it as PPTX in your office app.")
            : label("无法打开 PowerPoint 文件。", "Could not open the PowerPoint file.")}
        </p>
        <Button data-testid="taoffice-ppt-retry" onClick={() => setAttempt((value) => value + 1)}>{label("重试", "Retry")}</Button>
      </div> : <p role="status" className="taoffice-ppt-feedback">{label("正在打开演示文稿…", "Opening presentation…")}</p>}
  </section>;
}

function Presentation({ source, presentation, active, label, legacy }) {
  const [slide, setSlide] = useState(0);
  const [mode, setMode] = useState("preview");
  const editButton = useRef(null);
  const newButton = useRef(null);
  const editField = useRef(null);
  const focusTarget = useRef(null);
  const editHint = useId();
  const saveHint = useId();
  const draft = useDocumentDraft(source, (edits) => savePresentationCopy(presentation, edits));
  const page = presentation.slides[slide];
  const count = presentation.slides.length;
  const canSave = Boolean(source.saveCopy);
  const canSaveCopy = draft.dirty || (legacy && !draft.output);
  const canEdit = canSave && presentation.editable && page.paragraphs.length > 0;
  const pageStatus = label("第 " + (slide + 1) + " 张，共 " + count + " 张", "Slide " + (slide + 1) + " of " + count);

  useLayoutEffect(() => {
    const target = focusTarget.current?.current;
    focusTarget.current = null;
    if (target && !target.disabled) target.focus();
  }, [mode]);

  const preview = useMemo(() => {
    if (mode !== "preview") return null;
    try {
      return presentationPreviewBytes(presentation, draft.edits);
    } catch {
      return null;
    }
  }, [presentation, draft.edits, mode]);

  function save() {
    void draft.save({ allowUnedited: legacy }).catch(() => {});
  }

  function returnToPreview(trigger) {
    focusTarget.current = trigger;
    setMode("preview");
  }

  const editReason = !presentation.editable ? label("此演示文稿受保护。", "This presentation is protected.")
    : !page.paragraphs.length ? label("此幻灯片没有可编辑的文本。", "This slide has no editable text.") : "";
  const slideTitle = draft.edits.get(page.paragraphs[0]?.id) ?? page.visible[0] ?? "";
  const description = slideTitle ? pageStatus + " · " + slideTitle : pageStatus;

  return <div className="taoffice-ppt-content" onKeyDown={(event) => {
    if (!active || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (mode === "edit" && event.key === "Escape" && !draft.saving) {
      event.preventDefault();
      event.stopPropagation();
      returnToPreview(editButton);
      return;
    }
    const modifier = source.platform === "macos" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (mode !== "new" && modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s" && canSave && canSaveCopy) {
      event.preventDefault();
      event.stopPropagation();
      save();
    }
  }}>
    <div className="taoffice-ppt-toolbar" role="group" aria-label={label("演示文稿工具", "Presentation controls")}>
      <Button data-testid="taoffice-ppt-prev" disabled={mode === "new" || slide === 0}
        onClick={() => setSlide((value) => value - 1)}>{label("上一张", "Previous slide")}</Button>
      <span aria-live="polite" data-testid="taoffice-ppt-position" className="taoffice-ppt-position">{pageStatus}</span>
      <Button data-testid="taoffice-ppt-next" disabled={mode === "new" || slide === count - 1}
        onClick={() => setSlide((value) => value + 1)}>{label("下一张", "Next slide")}</Button>
      {canSave && <>
        <Button ref={editButton} data-testid="taoffice-ppt-edit" aria-pressed={mode === "edit"}
          aria-describedby={editReason ? editHint : undefined}
          disabled={mode === "new" || (!canEdit && mode !== "edit") || draft.saving}
          onClick={() => {
            if (mode === "edit") returnToPreview(editButton);
            else {
              focusTarget.current = editField;
              setMode("edit");
            }
          }}>{label("编辑幻灯片文本", "Edit slide text")}</Button>
        <Button ref={newButton} data-testid="taoffice-ppt-new" aria-pressed={mode === "new"}
          disabled={draft.dirty || draft.saving || mode === "new"} aria-describedby={draft.dirty ? saveHint : undefined}
          onClick={() => setMode("new")}>{label("新建演示文稿…", "New presentation…")}</Button>
        {mode !== "new" && <Button data-testid="taoffice-ppt-save" variant="primary" busy={draft.saving}
          disabled={!canSaveCopy} aria-describedby={!canSaveCopy ? saveHint : undefined} onClick={save}>
          {legacy ? label("保存 PPTX 副本…", "Save PPTX copy…") : label("保存副本…", "Save a copy…")}
        </Button>}
      </>}
    </div>
    {legacy && mode !== "new" && <p className="taoffice-ppt-feedback" data-testid="taoffice-ppt-conversion">
      {label("已导入为 PPTX。请检查复杂版式、动画和嵌入对象。", "Imported as PPTX. Review complex layouts, animations and embedded objects.")}
    </p>}
    {canSave && mode !== "new" && editReason && <p id={editHint} className="taoffice-ppt-feedback">{editReason}</p>}
    {canSave && mode !== "new" && <p id={saveHint} className="taoffice-ppt-feedback" data-testid="taoffice-ppt-save-hint">
      {draft.dirty ? label("保存文本修改后即可新建演示文稿。", "Save the text edits to create a new presentation.")
        : legacy ? label("可将转换结果另存为独立 PPTX 文件。", "You can save the conversion as a separate PPTX file.")
        : label("更改幻灯片文本后即可保存副本。", "Edit slide text to enable saving a copy.")}
    </p>}
    {draft.error && <p className="taoffice-ppt-feedback" role="alert">{label("无法保存演示文稿副本。", "Could not save the presentation copy.")}</p>}
    {draft.output && <p className="taoffice-ppt-feedback" role="status" data-testid="taoffice-ppt-output">{draft.output}</p>}
    {mode === "new" ? <NewPresentation source={source} active={active} label={label}
      restoreFocus={() => returnToPreview(newButton)} /> : mode === "edit" ? <div className="taoffice-ppt-editor"
      aria-label={label("幻灯片文本", "Slide text")}>
      {page.paragraphs.map((paragraph, index) => <label key={paragraph.id}>
        <span>{label("段落", "Paragraph")} {index + 1}</span>
        <input ref={index === 0 ? editField : undefined} className="taomni-input" type="text" value={draft.edits.get(paragraph.id) ?? paragraph.text}
          data-testid="taoffice-ppt-paragraph" disabled={draft.saving} maxLength={MAX_SLIDE_TEXT}
          onChange={(event) => draft.edit(paragraph.id, event.target.value, paragraph.text)} />
      </label>)}
    </div> : preview ? <>
      <SlidePreview bytes={preview} slide={slide} width={presentation.width} height={presentation.height} description={description} label={label} />
      <p className="taoffice-ppt-feedback">{label("静态预览。动画和部分嵌入对象请在 PowerPoint 中查看。",
        "Static preview. Open in PowerPoint for animations and some embedded objects.")}</p>
    </> : <p className="taoffice-ppt-feedback" role="alert">{label("无法准备演示文稿预览。", "Could not prepare the presentation preview.")}</p>}
  </div>;
}
