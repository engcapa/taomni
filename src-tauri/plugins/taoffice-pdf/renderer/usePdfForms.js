import { applyFormValue, loadForm, MAX_EXPORTED_BYTES, originalValue } from "./pdfForms.js";

const { React } = globalThis.__taomniHost;
const { useEffect, useLayoutEffect, useRef, useState } = React;

export function usePdfForms(pdf, source, label, onForms, saveAction, onPreviewChange) {
  const [model, setModel] = useState(null);
  const [values, setValues] = useState(new Map());
  const saved = useRef(new Map());
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const job = useRef(null);
  const live = useRef(true);
  const releaseDraft = useRef(null);
  const actions = useRef(null);
  const canEdit = Boolean(model?.editable && source.saveCopy && source.trackDraft);

  useEffect(() => {
    live.current = true;
    let cancelled = false;
    void loadForm(pdf).then((result) => {
      if (!cancelled) {
        setModel(result);
        onForms(result.fields.length > 0);
      }
    }).catch(() => { if (!cancelled) onForms(false); });
    return () => {
      cancelled = true;
      live.current = false;
      releaseDraft.current?.();
      releaseDraft.current = null;
    };
  }, [pdf, onForms]);

  function change(field, value) {
    if (job.current || !canEdit || !field.editable) return;
    const next = new Map(values).set(field.name, value);
    applyFormValue(pdf.annotationStorage, field, value);
    onPreviewChange();
    const changed = model.fields.some((item) => {
      const original = originalValue(item);
      return (next.get(item.name) ?? original) !== (saved.current.get(item.name) ?? original);
    });
    setValues(next);
    setDirty(changed);
    setError("");
    setStatus("");
  }

  function save() {
    if (job.current) return job.current;
    if (!dirty || !canEdit) return Promise.resolve(false);
    setSaving(true);
    setError("");
    setStatus("");
    const task = (async () => {
      try {
        const bytes = await pdf.saveDocument();
        if (!live.current) return false;
        if (bytes.length > MAX_EXPORTED_BYTES) throw new Error(label("PDF 副本超过 32 MiB。", "The PDF copy exceeds 32 MiB."));
        const path = await source.saveCopy(bytes);
        if (!path) return false;
        if (live.current) {
          saved.current = new Map(values);
          setDirty(false);
          setStatus(label(`已保存副本 ${path}`, `Saved copy ${path}`));
        }
        return true;
      } catch (reason) {
        if (live.current) setError(label("保存失败，请重试。", "Could not save the copy. Try again.") + " " + String(reason));
        throw reason;
      } finally {
        job.current = null;
        if (live.current) setSaving(false);
      }
    })();
    job.current = task;
    return task;
  }

  function discard() {
    if (job.current) return;
    for (const field of model.fields) {
      applyFormValue(pdf.annotationStorage, field, saved.current.get(field.name) ?? originalValue(field));
    }
    setValues(new Map(saved.current));
    setDirty(false);
    onPreviewChange();
  }

  useLayoutEffect(() => {
    actions.current = { save, discard };
    saveAction.current = dirty && canEdit ? () => actions.current.save() : null;
    if (dirty && canEdit && !releaseDraft.current) {
      releaseDraft.current = source.trackDraft({
        save: () => actions.current.save(),
        discard: () => actions.current.discard(),
      });
    } else if (!dirty || !canEdit) {
      releaseDraft.current?.();
      releaseDraft.current = null;
    }
  });

  useEffect(() => () => { saveAction.current = null; }, [saveAction]);
  return { model, values, dirty, error, status, saving, canEdit, change, save };
}
