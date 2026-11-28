import { Button } from "../../../crates/taomni-plugin-api/frontend/ui/Button";
import { useDocumentDraft } from "../../../crates/taomni-plugin-api/frontend/documentDraft.js";
import { cellProperties, fieldKey, MAX_TEXT, saveVisioCopy, validShapeEdits, validShapeValue } from "./visioPackage.js";
import { composing } from "./VisioFind.jsx";

const { React } = globalThis.__taomniHost;
const { useLayoutEffect, useId, useRef, useState } = React;

export function VisioShapes({ diagram, pageIndex, label, source, active, onPreview }) {
  const page = diagram?.pages[pageIndex];
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState(null);
  const origin = useRef(null);
  const first = useRef(null);
  const hint = useId();
  const shape = page?.shapes.find(item => item.id === selection) ?? page?.shapes[0];
  const draft = useDocumentDraft(source, edits => saveVisioCopy(diagram, edits));
  const valid = validShapeEdits(draft.edits);
  const errorId = useId();
  const fields = {
    Text: label("形状文本", "Shape text"), PinX: label("水平位置 (英寸)", "Horizontal position (in)"),
    PinY: label("垂直位置 (英寸)", "Vertical position (in)"),
    FillForegnd: label("填充颜色", "Fill color"), LineColor: label("线条颜色", "Line color"),
  };
  useLayoutEffect(() => {
    if (open) first.current?.focus();
  }, [open]);
  useLayoutEffect(() => {
    onPreview(draft.edits);
  }, [draft.edits, onPreview]);

  function close() {
    setOpen(false);
    origin.current?.focus();
  }

  function getValue(name) {
    return draft.edits.get(fieldKey(page, shape, name)) ?? shape.fields[name];
  }

  function edit(name, value) {
    draft.edit(fieldKey(page, shape, name), value, shape.fields[name]);
  }

  function save() {
    void draft.save().catch(() => {});
  }

  if (!source.saveCopy || source.extension !== "vsdx") return null;
  return <div className="taoffice-visio-editor" onKeyDown={event => {
    if (!active || composing(event) || event.defaultPrevented) return;
    if (event.key === "Escape" && open && !draft.saving) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
    const mod = source.platform === "macos" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    const saveKey = event.key.toLowerCase() === "s" || (event.key === "Enter" && event.target.tagName === "TEXTAREA");
    if (mod && !event.altKey && !event.shiftKey && saveKey && draft.dirty && valid) {
      event.preventDefault();
      event.stopPropagation();
      save();
    }
  }}>
    <div className="taoffice-visio-actions">
      <Button ref={origin} data-testid="taoffice-visio-edit-shapes" aria-expanded={open}
        aria-describedby={!shape ? hint : undefined} disabled={(!shape && !open) || draft.saving}
        onClick={() => open ? close() : setOpen(true)}>
        {label("编辑形状", "Edit shapes")}
      </Button>
      <Button data-testid="taoffice-visio-save-copy" disabled={!draft.dirty || !valid} busy={draft.saving}
        aria-describedby={valid ? hint : errorId} onClick={save}>{label("保存 VSDX 副本…", "Save VSDX copy…")}</Button>
      <span id={hint} className="taoffice-visio-note">
        {!shape ? label("此页没有可安全编辑的简单形状。", "This page has no supported editable shapes.")
          : draft.dirty ? label("副本包含尚未保存的修改。", "The copy has unsaved edits.")
          : label("编辑形状后可保存副本。", "Edit a shape to save a copy.")}
      </span>
    </div>
    {open && shape && <div className="taoffice-visio-fields">
      <label>{label("形状", "Shape")}
        <select ref={first} className="taomni-input" data-testid="taoffice-visio-shape"
          disabled={draft.saving} value={shape.id} onChange={event => setSelection(event.target.value)}>
          {page.shapes.map(item => <option key={item.id} value={item.id}>
            {item.id}{item.fields.Text && " · " + (draft.edits.get(fieldKey(page, item, "Text")) ?? item.fields.Text)}
          </option>)}
        </select>
      </label>
      {"Text" in shape.fields && <label>{fields.Text}
        <textarea className="taomni-input" data-testid="taoffice-visio-shape-text" maxLength={MAX_TEXT}
          value={getValue("Text")} disabled={draft.saving}
          onChange={event => edit("Text", event.target.value)} />
      </label>}
      {cellProperties.filter(name => name in shape.fields).map(name => <label key={name}>{fields[name]}
        {name.startsWith("Pin") ? <input className="taomni-input" type="number" min={-100000} max={100000} step="any"
          data-testid="taoffice-visio-shape-position" data-field={name} value={getValue(name)} disabled={draft.saving}
          aria-invalid={!validShapeValue(name, getValue(name)) || undefined}
          aria-describedby={!validShapeValue(name, getValue(name)) ? errorId : undefined}
          onChange={event => edit(name, event.target.value)} />
          : <input className="taomni-input" type="color" data-testid="taoffice-visio-shape-color" data-field={name}
            value={getValue(name)} disabled={draft.saving} onChange={event => edit(name, event.target.value)} />}
      </label>)}
    </div>}
    {!valid && <p id={errorId} className="taoffice-visio-status" role="alert">
      {label("请将位置设为 −100000 至 100000 的英寸数值，并检查形状文本。", "Enter a position from −100000 to 100000 inches and check the shape text.")}
    </p>}
    {draft.error && <p className="taoffice-visio-status" role="alert">
      {label("无法保存副本。请检查数值后重试。", "Could not save the copy. Check the shape values and retry.")}
    </p>}
    {draft.output && <p className="taoffice-visio-status" data-testid="taoffice-visio-copy-output" role="status">{draft.output}</p>}
  </div>;
}

