const { useLayoutEffect, useRef, useState } = globalThis.__taomniHost.React;

function sameEdits(first, second) {
  return first.size === second.size && [...first].every(([id, text]) => second.get(id) === text);
}

export function useDocumentDraft(source, createCopy) {
  const [edits, setEdits] = useState(() => new Map());
  const [saved, setSaved] = useState(() => new Map());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [output, setOutput] = useState("");
  const current = useRef(edits);
  const task = useRef(null);
  const latest = useRef(null);
  const dirty = !sameEdits(edits, saved);

  function edit(id, value, original) {
    if (task.current) return;
    const next = new Map(current.current);
    if (original === value) next.delete(id);
    else next.set(id, value);
    current.current = next;
    setEdits(next);
    setError("");
    setOutput("");
  }

  function save({ allowUnedited = false } = {}) {
    if (task.current) return task.current;
    const snapshot = current.current;
    if (!source.saveCopy || (!allowUnedited && sameEdits(snapshot, saved))) return Promise.resolve(false);
    setSaving(true);
    setError("");
    const work = Promise.resolve().then(async () => {
      const bytes = await createCopy(snapshot);
      const path = await source.saveCopy(bytes);
      if (!path) return false;
      setSaved(snapshot);
      setOutput(path);
      return true;
    }).catch((failure) => {
      setError(String(failure));
      throw failure;
    }).finally(() => {
      task.current = null;
      setSaving(false);
    });
    task.current = work;
    return work;
  }

  useLayoutEffect(() => {
    latest.current = {
      save,
      discard() {
        current.current = saved;
        setEdits(saved);
      },
    };
  });

  useLayoutEffect(() => {
    if (!dirty || !source.trackDraft) return;
    return source.trackDraft({
      save: () => latest.current.save(),
      discard: () => latest.current.discard(),
    });
  }, [dirty, source]);

  return { edits, dirty, saving, error, output, edit, save };
}
