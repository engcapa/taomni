/** Optional startup work yields a paint to the newly committed editor.
 * A second frame also lets its queued CodeMirror measurement run. The task
 * starts after that frame's paint, rather than mutating stores inside rAF. */
export function scheduleAfterEditorPaint(work: () => void, ready: () => boolean = () => true): () => void {
  let timer: number | null = null;
  let frame: number | null = null;
  const waitForEditor = () => {
    if (!ready()) {
      frame = window.requestAnimationFrame(waitForEditor);
      return;
    }
    frame = window.requestAnimationFrame(() => {
      frame = null;
      timer = window.setTimeout(() => {
        timer = null;
        work();
      }, 0);
    });
  };
  frame = window.requestAnimationFrame(waitForEditor);
  return () => {
    if (frame !== null) window.cancelAnimationFrame(frame);
    if (timer !== null) window.clearTimeout(timer);
  };
}
