export function normalizePdfText(value) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export async function findPdfPages(pdf, query, signal, layout) {
  const needle = normalizePdfText(query);
  const matches = [];
  if (!needle) return matches;
  for (const { number } of layout) {
    signal.throwIfAborted();
    const page = await pdf.getPage(number);
    signal.throwIfAborted();
    const { items } = await page.getTextContent();
    const text = items.map((item) => (item.str ?? "") + (item.hasEOL ? " " : "")).join("");
    if (normalizePdfText(text).includes(needle)) matches.push(number);
  }
  signal.throwIfAborted();
  return matches;
}

export function outlineEntries(items) {
  const entries = [];
  let visited = 0;
  const visit = (level, depth) => {
    for (const item of level) {
      if (++visited > 1000) return;
      if (item.dest) entries.push({ title: item.title, destination: item.dest, depth });
      if (item.items?.length && depth < 12) visit(item.items, depth + 1);
    }
  };
  visit(items ?? [], 0);
  return entries;
}

export async function outlinePage(pdf, destination) {
  const resolved = typeof destination === "string" ? await pdf.getDestination(destination) : destination;
  const reference = resolved?.[0];
  if (!reference && reference !== 0) throw new Error("PDF destination is missing");
  const index = Number.isInteger(reference) ? reference : await pdf.getPageIndex(reference);
  if (index < 0 || index >= pdf.numPages) throw new Error("PDF destination is outside the document");
  return index + 1;
}
