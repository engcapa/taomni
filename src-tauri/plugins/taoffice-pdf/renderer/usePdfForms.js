import { applyFormValue, loadForm, MAX_EXPORTED_BYTES, originalValue } from "./pdfForms.js";
import { sameLayout } from "./pdfEditorState.js";

const { React } = globalThis.__taomniHost;
const { useEffect, useLayoutEffect, useMemo, useRef, useState } = React;

const EMPTY_MARKUP = new Map();
const EMPTY_LAYOUT = [];

export function usePdfForms(pdf, source, label, saveAction, onPreviewChange, pages) {
  const [loaded, setLoaded] = useState(null);
  const [values, setValues] = useState(new Map());
  const saved = useRef(new Map());
  const [layoutDraft, setLayout] = useState(null);
  const layout = layoutDraft ?? pages;
  const [markup, setMarkup] = useState(EMPTY_MARKUP);
  const savedPages = useRef(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const job = useRef(null);
  const live = useRef(null);
  const releaseDraft = useRef(null);
  const actions = useRef(null);
  const model = loaded?.pdf === pdf ? loaded : null;
  const writable = Boolean(source.saveCopy && source.trackDraft);
  const canEdit = writable && Boolean(model?.editable);
  const canEditPages = writable && Boolean(model?.pageEditable);
  const savedLayout = savedPages.current?.layout ?? pages;
  const formDirty = canEdit && model.fields.some((field) => {
    const original = originalValue(field);
    return (values.get(field.name) ?? original) !== (saved.current.get(field.name) ?? original);
  });
  const fields = useMemo(() => {
    const positions = new Map(layout.map(({ number }, index) => [number, index + 1]));
    return (model?.fields ?? []).flatMap((field) => {
      const widget = field.widgets.find((item) => positions.has(item.page + 1));
      return widget ? [{ ...field, visiblePage: positions.get(widget.page + 1), sourcePage: widget.page + 1 }] : [];
    });
  }, [model, layout]);
  const pagesDirty = canEditPages && (!sameLayout(layout, savedLayout) || markup !== (savedPages.current?.markup ?? EMPTY_MARKUP));
  const dirty = formDirty || pagesDirty;

  useLayoutEffect(() => {
    const owner = { pdf };
    live.current = owner;
    setValues(new Map());
    saved.current = new Map();
    setLayout(null);
    setMarkup(EMPTY_MARKUP);
    savedPages.current = null;
    setStatus("");
    setError("");
    setSaving(false);
    job.current = null;
    if (!pdf) return;
    void loadForm(pdf).then((result) => {
      if (live.current === owner) setLoaded({ ...result, pdf });
    }).catch(() => { if (live.current === owner) setLoaded(null); });
    return () => {
      live.current = null;
      releaseDraft.current?.();
      releaseDraft.current = null;
    };
  }, [pdf, source]);

  function change(field, value) {
    if (job.current || !canEdit || !field.editable) return;
    setValues((previous) => new Map(previous).set(field.name, value));
    applyFormValue(pdf.annotationStorage, field, value);
    onPreviewChange();
    setError("");
    setStatus("");
  }

  function changeLayout(next) {
    if (!canEditPages || job.current) return;
    setLayout(next);
    setError("");
    setStatus("");
  }

  function addMarkup(number, annotation) {
    if (!canEditPages || job.current) return;
    setMarkup((previous) => new Map(previous).set(number, [...(previous.get(number) ?? []), annotation]));
    setError("");
    setStatus("");
  }

  function undoMarkup(number) {
    if (!canEditPages || job.current || !markup.get(number)?.length) return;
    const next = new Map(markup);
    const remaining = next.get(number).slice(0, -1);
    if (remaining.length) next.set(number, remaining);
    else next.delete(number);
    setMarkup(next.size ? next : EMPTY_MARKUP);
    setError("");
    setStatus("");
  }

  function save() {
    if (job.current) return job.current;
    if (!dirty || !writable) return Promise.resolve(false);
    const owner = live.current;
    setSaving(true);
    setError("");
    setStatus("");
    const task = (async () => {
      try {
        let bytes = values.size ? await pdf.saveDocument() : await pdf.getData();
        if (markup.size || !sameLayout(layout, pages)) {
          const { savePdfPageEdits } = await import("./pdfPageEdits.js");
          bytes = await savePdfPageEdits(bytes, layout, markup);
        }
        if (live.current !== owner) return false;
        if (bytes.length > MAX_EXPORTED_BYTES) throw new Error(label("PDF 副本超过 32 MiB。", "The PDF copy exceeds 32 MiB."));
        const path = await source.saveCopy(bytes);
        if (!path) return false;
        if (live.current === owner) {
          saved.current = new Map(values);
          savedPages.current = { layout, markup };
          setStatus(label(`已保存副本 ${path}`, `Saved copy ${path}`));
        }
        return true;
      } catch (reason) {
        if (live.current === owner) setError(label("保存失败，请重试。", "Could not save the copy. Try again.") + " " + String(reason));
        throw reason;
      } finally {
        if (live.current === owner) {
          job.current = null;
          setSaving(false);
        }
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
    setLayout(savedPages.current?.layout ?? null);
    setMarkup(savedPages.current?.markup ?? EMPTY_MARKUP);
    onPreviewChange();
  }

  useLayoutEffect(() => {
    actions.current = { save, discard };
    saveAction.current = dirty ? () => actions.current.save() : null;
    if (dirty && !releaseDraft.current) {
      releaseDraft.current = source.trackDraft({
        save: () => actions.current.save(),
        discard: () => actions.current.discard(),
      });
    } else if (!dirty) {
      releaseDraft.current?.();
      releaseDraft.current = null;
    }
  });

  useEffect(() => () => { saveAction.current = null; }, [saveAction]);
  return { fields, values, dirty, error, status, saving, canEdit, canEditPages, change, save,
    layout: layout ?? EMPTY_LAYOUT, markup, changeLayout, addMarkup, undoMarkup };
}
