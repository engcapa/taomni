import { docxPreviewBytes, MAX_DOCX_BYTES, openDocx } from "./docxPackage.js";
import { convertLegacyWord, isLegacyWordFormat } from "./legacyWord.js";
import { renderWordPreview } from "./wordPreview.js";

const { useEffect, useRef, useState } = globalThis.__taomniHost.React;

export function useWordPreview(source) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState(null);
  const activeTask = useRef(null);
  const legacy = isLegacyWordFormat(source.extension);

  useEffect(() => {
    const task = new AbortController();
    activeTask.current = task;
    const update = (state) => {
      if (!task.signal.aborted) setResult({ ...state, source, attempt });
    };
    async function load() {
      const file = await source.read();
      task.signal.throwIfAborted();
      if (file.size > MAX_DOCX_BYTES) throw new Error("limits");
      const bytes = new Uint8Array(await file.arrayBuffer());
      task.signal.throwIfAborted();
      if (legacy) update({ phase: "converting" });
      const packageBytes = legacy ? await convertLegacyWord(bytes, source.extension, task.signal) : bytes;
      const document = openDocx(packageBytes);
      const preview = await renderWordPreview(docxPreviewBytes(document, new Map()));
      update({ phase: "ready", document, preview });
    }
    void load().catch((error) => update({ phase: "failed", error }));
    return () => {
      task.abort();
      if (activeTask.current === task) activeTask.current = null;
    };
  }, [source, attempt, legacy]);

  return {
    state: result?.source === source && result.attempt === attempt ? result : { phase: "opening" },
    legacy,
    retry: () => setAttempt((value) => value + 1),
    cancel() {
      activeTask.current?.abort();
      setResult({ source, attempt, phase: "cancelled" });
    },
  };
}
