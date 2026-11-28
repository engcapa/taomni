import { originalValue } from "./pdfForms.js";

const { React } = globalThis.__taomniHost;
const { useId, useLayoutEffect, useRef } = React;

export function PdfForms({ form, source, expanded, active, onClose, onPage, label }) {
  const heading = useId();
  const panel = useRef(null);
  useLayoutEffect(() => {
    if (expanded && active) panel.current?.focus();
  }, [expanded, active]);
  if (!expanded || !form.fields.length) return null;

  return <section aria-labelledby={heading} className="taoffice-pdf-form" data-testid="taoffice-pdf-form"
    ref={panel} tabIndex={-1} onKeyDown={(event) => {
      if (!active || event.nativeEvent.isComposing || event.keyCode === 229) return;
      const mod = source.platform === "macos" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (mod && event.key === "s" && !event.shiftKey && !event.altKey && form.dirty) {
        event.preventDefault();
        event.stopPropagation();
        void form.save().catch(() => {});
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }}>
    <div className="taoffice-pdf-form-actions">
      <h3 id={heading}>{label("表单字段", "Form fields")}</h3>
      {form.canEdit && <button type="button" className="taomni-btn" disabled={!form.dirty || form.saving}
        data-testid="taoffice-pdf-save-copy" onClick={() => { void form.save().catch(() => {}); }}>
        {label("保存副本…", "Save a copy…")}
      </button>}
      <button type="button" className="taomni-btn" onClick={onClose}>{label("关闭表单", "Close form")}</button>
    </div>
    {!form.canEdit && <p role="status">{label("表单为只读", "This form is read-only")}</p>}
    {form.saving && <p role="status">{label("正在保存 PDF 副本…", "Saving PDF copy…")}</p>}
    {form.status && <p role="status" data-testid="taoffice-pdf-copy-output">{form.status}</p>}
    {form.error && <p role="alert" className="taoffice-pdf-error">{form.error}</p>}
    <div className="taoffice-pdf-form-fields">
      {form.fields.map((field) => <FormField key={field.id} field={field} editable={form.canEdit && field.editable && !form.saving}
        value={form.values.get(field.name) ?? originalValue(field)} onLocate={() => onPage(field.sourcePage)}
        onChange={(value) => form.change(field, value)} label={label} />)}
    </div>
  </section>;
}

function FormField({ field, value, onChange, onLocate, editable, label }) {
  const name = field.name;
  const testProps = { "data-field": name, "data-testid": "taoffice-pdf-form-field" };
  const textProps = {
    ...testProps, className: "taomni-input", value, readOnly: !editable,
    maxLength: field.charLimit || 32767, onChange: (event) => onChange(event.target.value),
  };
  let control;
  switch (field.type) {
    case "checkbox":
      control = <input {...testProps} type="checkbox" disabled={!editable} checked={value}
        onChange={(event) => onChange(event.target.checked)} />;
      break;
    case "combobox":
    case "listbox":
      control = <select {...testProps} className="taomni-input" disabled={!editable} value={value}
        onChange={(event) => onChange(event.target.value)}>
        <option value="">{label("请选择", "Select a value")}</option>
        {(field.items ?? []).filter((item) => item.exportValue !== "").map((item, index) =>
          <option key={index} value={item.exportValue}>{item.displayValue}</option>)}
      </select>;
      break;
    default:
      control = field.multiline ? <textarea {...textProps} rows={2} /> : <input {...textProps} type="text" />;
  }
  return <div className="taoffice-pdf-form-row">
    <label><span title={name}>{name}</span>{control}</label>
    <button type="button" className="taomni-btn" onClick={onLocate}>
      {label(`第 ${field.visiblePage} 页`, `Page ${field.visiblePage}`)}
    </button>
  </div>;
}
