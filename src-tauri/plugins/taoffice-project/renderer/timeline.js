const DAY = 86_400_000;

export function taskDay(value) {
  const date = value?.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date ?? "")) return null;
  const timestamp = Date.parse(date + "T00:00:00Z");
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) return null;
  return timestamp;
}

export function timelineExtent(tasks) {
  let first = Infinity;
  let last = -Infinity;
  for (const task of tasks) {
    const start = taskDay(task.start);
    const finish = taskDay(task.finish);
    if (start === null || finish === null || start > finish) continue;
    first = Math.min(first, start);
    last = Math.max(last, finish);
  }
  return Number.isFinite(first) ? { first, last, span: last - first + DAY } : null;
}

export function taskBar(task, extent) {
  if (!extent) return null;
  const start = taskDay(task.start);
  const finish = taskDay(task.finish);
  if (start === null || finish === null || start > finish) return null;
  return {
    left: (start - extent.first) / extent.span * 100,
    width: (finish - start + DAY) / extent.span * 100,
  };
}
