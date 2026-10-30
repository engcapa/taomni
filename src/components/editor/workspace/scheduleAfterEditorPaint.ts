interface PaintTask {
  work: () => void;
  ready: () => boolean;
  remainingPaints: number;
}

const pending = new Set<PaintTask>();
let frame: number | null = null;
let timer: number | null = null;

function scheduleFrame() {
  if (!pending.size || frame !== null || timer !== null) return;
  frame = window.requestAnimationFrame(() => {
    frame = null;
    let next: PaintTask | undefined;
    try {
      for (const task of pending) {
        let ready: boolean;
        try {
          ready = task.ready();
        } catch (error) {
          pending.delete(task);
          throw error;
        }
        task.remainingPaints = ready ? Math.max(0, task.remainingPaints - 1) : 2;
        if (!next && task.remainingPaints === 0) next = task;
      }
      if (next) {
        const task = next;
        timer = window.setTimeout(() => {
          timer = null;
          try {
            if (pending.delete(task)) task.work();
          } finally {
            scheduleFrame();
          }
        }, 0);
      }
    } finally {
      scheduleFrame();
    }
  });
}

/** Optional startup work follows the editor's measurement and paint. Share one
 * queue so grammar installation, discovery and chrome projections cannot all
 * rebuild the workspace in the same turn. Pending ports do not block mounts. */
export function scheduleAfterEditorPaint(work: () => void, ready: () => boolean = () => true): () => void {
  const task: PaintTask = { work, ready, remainingPaints: 2 };
  pending.add(task);
  scheduleFrame();
  return () => {
    pending.delete(task);
    if (pending.size) return;
    if (frame !== null) window.cancelAnimationFrame(frame);
    if (timer !== null) window.clearTimeout(timer);
    frame = null;
    timer = null;
  };
}
