import { drawioFile, type DrawioPage } from "./drawioCodec";
import { drawioPlainText } from "./drawioRender";

export type DrawioImportMode = "diagram" | "text";
const mdText = (text: string) => text.replace(/[\\`*_{}[\]<>#!|]/g, "\\$&");
const cellText = (cell: Element) => drawioPlainText(cell.getAttribute("value") || cell.parentElement?.getAttribute("label") || "");
const fence = (kind: string, value: string) => {
  const length = Math.max(3, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length + 1));
  return `${"`".repeat(length)}${kind}\n${value}\n${"`".repeat(length)}`;
};

function textCellMarkdown(cell: Element): string {
  const plain = cellText(cell);
  const tag = cell.getAttribute("taomniTag");
  if (tag && /^h[1-6]$/.test(tag)) return `${"#".repeat(Number(tag[1]))} ${mdText(plain)}`;
  if (tag === "pre") return fence("", plain);
  return mdText(plain);
}

function tableMarkdown(table: Element, model: Element): string {
  const id = table.getAttribute("id")!;
  const cells = Array.from(model.querySelectorAll("mxCell")).filter((cell) => cell.getAttribute("parent") === id);
  const rows = new Map<number, Map<number, string>>();
  for (const cell of cells) {
    const row = Number(cell.getAttribute("taomniRow")), column = Number(cell.getAttribute("taomniColumn"));
    if (!Number.isInteger(row) || row < 0 || row > 1000 || !Number.isInteger(column) || column < 0 || column > 100) throw new Error("Invalid draw.io table coordinates");
    if (!rows.has(row)) rows.set(row, new Map());
    rows.get(row)!.set(column, mdText(cellText(cell)).replace(/\n/g, "<br>"));
  }
  const columns = Math.max(1, ...cells.map((cell) => Number(cell.getAttribute("taomniColumn")) + 1));
  const line = (row: Map<number, string>) => `| ${Array.from({ length: columns }, (_, column) => row.get(column) || "").join(" | ")} |`;
  const ordered = Array.from(rows).sort(([a], [b]) => a - b).map(([, row]) => line(row));
  if (!ordered.length) return "";
  ordered.splice(1, 0, `| ${Array(columns).fill("---").join(" | ")} |`);
  return ordered.join("\n");
}

function externalTableMarkdown(table: Element, model: Element): string {
  const all = Array.from(model.querySelectorAll("mxCell"));
  const id = table.getAttribute("id");
  const children = (parent: string | null) => all.filter((cell) => cell.getAttribute("parent") === parent);
  const coordinate = (cell: Element, field: string) => Number(cell.querySelector("mxGeometry")?.getAttribute(field) || 0);
  const rows = children(id).sort((a, b) => coordinate(a, "y") - coordinate(b, "y"));
  const values = rows.map((row) => children(row.getAttribute("id")).sort((a, b) => coordinate(a, "x") - coordinate(b, "x")).map((cell) => mdText(cellText(cell)).replace(/\n/g, "<br>")));
  const columns = Math.max(0, ...values.map((row) => row.length));
  if (!columns) return "";
  const lines = values.map((row) => `| ${Array.from({ length: columns }, (_, column) => row[column] || "").join(" | ")} |`);
  lines.splice(1, 0, `| ${Array(columns).fill("---").join(" | ")} |`);
  return lines.join("\n");
}

/** Recognize actual editable text cells and our table contract, never flatten
 * arbitrary diagram node labels into prose or discard an unfamiliar drawing. */
export function drawioToMarkdown(pages: DrawioPage[], mode: DrawioImportMode): string {
  if (!pages.length) throw new Error("Select at least one draw.io sheet");
  if (mode === "diagram") return pages.map((page) => `## ${mdText(page.name)}\n\n${fence("drawio", drawioFile([page]))}`).join("\n\n") + "\n";
  return pages.map((page) => {
    const model = page.model.cloneNode(true) as Element;
    const cells = Array.from(model.querySelectorAll("root > mxCell"));
    const textCells = cells.filter((cell) => !cell.getAttribute("taomniKind")?.startsWith("sequence-")
      && (cell.getAttribute("taomniKind") === "text" || /(?:^|;)(?:shape=)?text(?:;|$)/.test(cell.getAttribute("style") || "")));
    const tables = cells.filter((cell) => cell.getAttribute("taomniKind") === "table" || /(?:^|;)shape=table(?:;|$)/.test(cell.getAttribute("style") || ""));
    const blocks = [...textCells, ...tables].sort((a, b) => Number(a.querySelector("mxGeometry")?.getAttribute("y") || 0) - Number(b.querySelector("mxGeometry")?.getAttribute("y") || 0));
    const content = blocks.map((cell) => tables.includes(cell)
      ? cell.getAttribute("taomniKind") === "table" ? tableMarkdown(cell, model) : externalTableMarkdown(cell, model)
      : textCellMarkdown(cell)).filter(Boolean);
    const remove = new Set([...blocks, ...cells.filter((cell) => cell.getAttribute("taomniKind") === "sheet-reference")].map((cell) => cell.getAttribute("id")));
    for (let pass = 0, previous = -1; pass < 100 && previous !== remove.size; pass++) {
      previous = remove.size;
      for (const cell of cells) if (remove.has(cell.getAttribute("parent"))) remove.add(cell.getAttribute("id"));
    }
    model.querySelectorAll("mxCell").forEach((cell) => { if (remove.has(cell.getAttribute("id"))) cell.remove(); });
    const remaining = model.querySelector("mxCell[vertex='1'],mxCell[edge='1']");
    if (remaining) content.push(fence("drawio", drawioFile([{ ...page, model }])));
    content.push(fence("drawio-source", drawioFile([page])));
    return `## ${mdText(page.name)}\n\n${content.join("\n\n")}`;
  }).join("\n\n") + "\n";
}
