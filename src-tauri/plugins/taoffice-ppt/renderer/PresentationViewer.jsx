import { Button } from "../../../crates/taomni-plugin-api/frontend/ui/Button.tsx";
import { useDocumentDraft } from "../../../crates/taomni-plugin-api/frontend/documentDraft.js";
import { MAX_PRESENTATION_BYTES, openPresentation, presentationPreviewBytes, savePresentationCopy } from "./presentationPackage.js";
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

  useEffect(() => {
    let current = true;
    async function open() {
      const file = await source.read();
      if (!current) return;
      if (file.size > MAX_PRESENTATION_BYTES) {
        setLoad({ source, attempt, tooLarge: true });
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!current) return;
      const presentation = openPresentation(bytes);
      setLoad({ source, attempt, presentation });
    }
    void open().catch(() => { if (current) setLoad({ source, attempt, failed: true }); });
    return () => { current = false; };
  }, [source, attempt]);

  const outcome = load?.source === source && load.attempt === attempt ? load : null;
  return <section className="taoffice-ppt" aria-label={source.name} data-testid="taoffice-ppt">
    <style>{styles}</style>
    {outcome?.presentation ? <Presentation source={source} presentation={outcome.presentation} active={active} label={label} />
      : outcome ? <div className="taoffice-ppt-feedback" role="alert" data-testid="taoffice-ppt-error">
        <p>{outcome.tooLarge ? label("PPTX 预览上限为 24 MiB。", "PPTX preview is limited to 24 MiB.")
          : label("无法打开 PowerPoint 文件。", "Could not open the PowerPoint file.")}</p>
        <Button onClick={() => setAttempt((value) => value + 1)}>{label("重试", "Retry")}</Button>
      </div> : <p role="status" className="taoffice-ppt-feedback">{label("正在打开演示文稿…", "Opening presentation…")}</p>}
  </section>;
}

function Presentation({ source, presentation, active, label }) {
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
    void draft.save().catch(() => {});
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
    if (mode !== "new" && modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s" && draft.dirty) {
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
          disabled={!draft.dirty} aria-describedby={!draft.dirty ? saveHint : undefined} onClick={save}>
          {label("保存副本…", "Save a copy…")}
        </Button>}
      </>}
    </div>
    {canSave && mode !== "new" && editReason && <p id={editHint} className="taoffice-ppt-feedback">{editReason}</p>}
    {canSave && mode !== "new" && <p id={saveHint} className="taoffice-ppt-feedback" data-testid="taoffice-ppt-save-hint">
      {draft.dirty ? label("保存文本修改后即可新建演示文稿。", "Save the text edits to create a new presentation.")
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
