import { diff } from "@codemirror/merge";

export function distributeText(spans, original, updated) {
  if (spans.length === 1) return [updated];

  let offset = 0;
  const offsets = spans.map(({ text }) => {
    const start = offset;
    offset += text.length;
    return { start, end: offset };
  });
  const replacements = spans.map(({ text }) => text);

  // Apply changes from the end so offsets still refer to the original runs.
  for (const change of [...diff(original, updated, { scanLimit: 512 })].reverse()) {
    const inserted = updated.slice(change.fromB, change.toB);
    const owner = offsets.findIndex(({ end }) => change.fromA < end);
    const first = owner === -1 ? offsets.length - 1 : owner;

    for (let index = first; index < offsets.length; index++) {
      const { start, end } = offsets[index];
      if (index > first && start >= change.toA) break;
      const localStart = Math.max(0, change.fromA - start);
      const localEnd = Math.min(end, change.toA) - start;
      const text = replacements[index];
      const replacement = index === first ? inserted : "";
      replacements[index] = text.slice(0, localStart) + replacement + text.slice(localEnd);
    }
  }
  return replacements;
}
