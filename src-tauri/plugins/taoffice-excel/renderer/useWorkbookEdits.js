import { changedEdits, excelEditKey, MAX_EDITS, workbookCopyBytes } from "./workbookEdits.js";

const { React } = globalThis.__taomniHost;
const { useEffect, useLayoutEffect, useRef, useState } = React;

export function useWorkbookEdits(book, source, api) {
  const [edits, setEdits] = useState(new Map());
  const [saved, setSaved] = useState(new Map());
  const [saving, setSaving] = useState(false);
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");
  const task = useRef(null);
  const controller = useRef(null);
  const latest = useRef(null);
  const currentEdits = useRef(edits);
  const permitted = Boolean(book && source.extension === "xlsx" && source.saveCopy && source.trackDraft);
  const dirty = changedEdits(edits, saved);

  useEffect(() => {
    const operation = new AbortController();
    controller.current = operation;
    currentEdits.current = new Map();
    setEdits(currentEdits.current);
    setSaved(new Map());
    setError("");
    setOutput("");
    setSaving(false);
    return () => operation.abort();
  }, [book, source]);

  function apply(sheet, address, original, value) {
    if (!permitted || task.current) return false;
    const key = excelEditKey(sheet, address);
    const existing = currentEdits.current;
    if (value !== original && !existing.has(key) && existing.size >= MAX_EDITS) return false;
    const next = new Map(existing);
    if (value === original) next.delete(key);
    else next.set(key, { sheet, address, value });
    currentEdits.current = next;
    setEdits(next);
    setError("");
    setOutput("");
    return true;
  }

  function save() {
    if (task.current) return task.current;
    const snapshot = currentEdits.current;
    if (!permitted || !changedEdits(snapshot, saved) || !controller.current) return Promise.resolve(false);
    const { signal } = controller.current;
    setSaving(true);
    setError("");
    const work = (async () => {
      try {
        const result = await workbookCopyBytes(api, book.id, snapshot, signal);
        signal.throwIfAborted();
        const target = await source.saveCopy(result);
        if (!target || signal.aborted) return false;
        setSaved(snapshot);
        setOutput(target);
        return true;
      } catch (failure) {
        if (!signal.aborted) setError(failure.message ?? String(failure));
        throw failure;
      } finally {
        task.current = null;
        if (!signal.aborted) setSaving(false);
      }
    })();
    task.current = work;
    return work;
  }

  useLayoutEffect(() => {
    latest.current = {
      save,
      discard: () => {
        currentEdits.current = saved;
        setEdits(saved);
      },
    };
  });

  useLayoutEffect(() => {
    if (permitted && dirty) return source.trackDraft({
      save: () => latest.current.save(),
      discard: () => latest.current.discard(),
    });
  }, [source, permitted, dirty]);

  return { permitted, edits, dirty, saving, output, error, apply, save };
}
