export function originalPages(count) {
  return Array.from({ length: count }, (_, index) => ({ number: index + 1, rotation: 0 }));
}

export function sameLayout(first, second) {
  return first.length === second.length && first.every(({ number, rotation }, index) =>
    number === second[index].number && rotation === second[index].rotation);
}

export function changePageLayout(layout, pageNumber, action) {
  const index = layout.findIndex(({ number }) => number === pageNumber);
  const item = layout[index];
  if (!item) return layout;
  const next = layout.slice();
  if (action === "rotate") {
    next[index] = { ...item, rotation: (item.rotation + 90) % 360 };
  } else if (action === "remove") {
    if (next.length <= 1) return layout;
    next.splice(index, 1);
  } else {
    const destination = index + (action === "earlier" ? -1 : 1);
    if (destination < 0 || destination >= next.length) return layout;
    [next[index], next[destination]] = [next[destination], next[index]];
  }
  return next;
}
