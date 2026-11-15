import { marked, type Token, type Tokens } from "marked";

export interface MarkdownBlock {
  from: number;
  to: number;
  raw: string;
  token: Token;
}
export interface MarkdownHeading { from: number; level: number; text: string }
export type TableAlignment = "left" | "center" | "right" | null;
export interface MarkdownTable { rows: string[][]; align: TableAlignment[] }

export function markdownBlocks(content: string): MarkdownBlock[] {
  let offset = 0;
  return marked.lexer(content, { gfm: true, breaks: true }).map((token) => {
    const from = offset;
    offset += token.raw.length;
    return { from, to: offset, raw: token.raw, token };
  });
}

export function markdownHeadings(content: string): MarkdownHeading[] {
  return markdownBlocks(content).flatMap((block) => block.token.type === "heading"
    ? [{ from: block.from, level: (block.token as Tokens.Heading).depth,
      text: (block.token as Tokens.Heading).text.replace(/[*_`~]/g, "") }]
    : []);
}

export function tableFromToken(token: Tokens.Table): MarkdownTable {
  return { rows: [token.header.map((cell) => cell.text), ...token.rows.map((row) => row.map((cell) => cell.text))],
    align: token.align };
}

export function escapeTableCell(value: string): string {
  return value.replace(/\r?\n/g, "<br>").replace(/(?<!\\)\|/g, "\\|");
}

export function serializeTable(table: MarkdownTable): string {
  const columns = Math.max(1, table.align.length, ...table.rows.map((row) => row.length));
  const row = (cells: string[]) => `| ${Array.from({ length: columns }, (_, i) => escapeTableCell(cells[i] ?? "")).join(" | ")} |`;
  const separator = Array.from({ length: columns }, (_, i) => {
    const align = table.align[i];
    return align === "center" ? ":---:" : align === "right" ? "---:" : align === "left" ? ":---" : "---";
  });
  const rows = table.rows.length ? table.rows : [Array(columns).fill("")];
  return [row(rows[0]), row(separator), ...rows.slice(1).map(row)].join("\n") + "\n";
}

export function modifyTable(
  table: MarkdownTable,
  action: "row-before" | "row-after" | "column-before" | "column-after" | "delete-row" | "delete-column" | "left" | "center" | "right",
  row: number,
  column: number,
): MarkdownTable {
  const next = { rows: table.rows.map((cells) => [...cells]), align: [...table.align] };
  if (action === "row-before" || action === "row-after") {
    next.rows.splice(Math.max(1, row + (action === "row-after" ? 1 : 0)), 0, Array(next.align.length).fill(""));
  } else if (action === "column-before" || action === "column-after") {
    const index = column + (action === "column-after" ? 1 : 0);
    next.rows.forEach((cells) => cells.splice(index, 0, ""));
    next.align.splice(index, 0, null);
  } else if (action === "delete-row" && row > 0) next.rows.splice(row, 1);
  else if (action === "delete-column" && next.align.length > 1) {
    next.rows.forEach((cells) => cells.splice(column, 1));
    next.align.splice(column, 1);
  } else if (action === "left" || action === "center" || action === "right") next.align[column] = action;
  return next;
}

export interface TablePaste { markdown: string; warning?: "merged" }

export function convertTablePaste(html: string, text: string): TablePaste | null {
  const parsed = html ? new DOMParser().parseFromString(html, "text/html") : null;
  const table = parsed?.querySelector("table");
  if (table) {
    if (table.querySelector("[rowspan]:not([rowspan='1']),[colspan]:not([colspan='1']), table")) {
      return { markdown: text || table.textContent || "", warning: "merged" };
    }
    const rows = Array.from(table.rows).map((row) => Array.from(row.cells).map((cell) => {
      // Clipboard HTML is never inserted into the editor DOM. Preserve inline
      // line breaks as standard Markdown HTML, discarding scripts and styling.
      const copy = cell.cloneNode(true) as HTMLElement;
      copy.querySelectorAll("script,style").forEach((node) => node.remove());
      copy.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
      return copy.textContent?.trim() || "";
    }));
    const columns = Math.max(0, ...rows.map((row) => row.length));
    if (!rows.length || !columns) return null;
    return { markdown: serializeTable({ rows, align: Array(columns).fill(null) }) };
  }
  if (!text.includes("\t")) return null;
  const rows = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").map((row) => row.split("\t"));
  const columns = Math.max(...rows.map((row) => row.length));
  if (columns < 2) return null;
  return { markdown: serializeTable({ rows, align: Array(columns).fill(null) }) };
}

export interface StandaloneImage { alt: string; href: string; title: string | null }
export function standaloneImage(token: Token): StandaloneImage | null {
  if (token.type !== "paragraph") return null;
  const children = (token as Tokens.Paragraph).tokens.filter((child) => child.type !== "text" || child.raw.trim());
  if (children.length !== 1 || children[0].type !== "image") return null;
  const image = children[0] as Tokens.Image;
  return { alt: image.text, href: image.href, title: image.title };
}
