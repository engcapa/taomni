import { describe, expect, it } from "vitest";
import { convertTablePaste, markdownBlocks, markdownHeadings, modifyTable, serializeTable, tableFromToken } from "./markdownModel";
import type { Tokens } from "marked";

const samples = [
  "# 标题\n\n正文 **粗体** [link](https://example.test)\n",
  "- [ ] item\n- [x] done\n\n> quote\n",
  "Title\n=====\n\n```mermaid\nflowchart LR\n  A --> B\n```\n",
  "| a | b |\n| :--- | ---: |\n| c\\|d | e |\n\n![图](assets/a%20b.png)\n",
  "<div>HTML &amp; raw</div>\n\n[image]: assets/a.png\n\n![x][image]\n",
];
describe("lossless Markdown presentation model", () => {
  it.each(samples)("keeps byte-for-byte Markdown source while finding blocks: %s", (source) => {
    const blocks = markdownBlocks(source);
    expect(blocks.map((block) => block.raw).join("")).toBe(source);
    for (const block of blocks) expect(source.slice(block.from, block.to)).toBe(block.raw);
  });
  it("finds headings but not fenced-code headings", () => {
    const source = "# Top\n\n```md\n# fake\n```\n\nSub\n---\n";
    expect(markdownHeadings(source)).toEqual([{ from: 0, level: 1, text: "Top" }, { from: source.indexOf("Sub"), level: 2, text: "Sub" }]);
  });
  it("serializes alignment, escaped pipes and line breaks as standard Markdown", () => {
    const result = serializeTable({ rows: [["a|b", "c"], ["d\ne", "f"]], align: ["left", "right"] });
    expect(result).toBe("| a\\|b | c |\n| :--- | ---: |\n| d<br>e | f |\n");
    const token = markdownBlocks(result)[0].token as Tokens.Table;
    expect(tableFromToken(token).rows).toHaveLength(2);
  });
  it("inserts/deletes rows and columns and keeps a valid header", () => {
    const original = { rows: [["a", "b"], ["c", "d"]], align: [null, null] };
    const inserted = modifyTable(original, "row-before", 0, 0);
    expect(inserted.rows).toEqual([["a", "b"], ["", ""], ["c", "d"]]);
    expect(modifyTable(inserted, "delete-row", 0, 0).rows).toEqual(inserted.rows);
    const column = modifyTable(inserted, "column-after", 0, 0);
    expect(column.rows[0]).toEqual(["a", "", "b"]);
    expect(modifyTable(column, "right", 1, 1).align).toEqual([null, "right", null]);
    expect(original.rows).toEqual([["a", "b"], ["c", "d"]]);
  });
  it("converts HTML table and TSV; degrades merged cells without silently flattening", () => {
    expect(convertTablePaste("<table><tr><th>A</th><th>B</th></tr><tr><td>x|y<br>z</td><td>safe<script>evil()</script></td></tr></table>", "")?.markdown)
      .toBe("| A | B |\n| --- | --- |\n| x\\|y<br>z | safe |\n");
    expect(convertTablePaste("", "A\tB\r\nx\ty\r\n")?.markdown).toBe("| A | B |\n| --- | --- |\n| x | y |\n");
    expect(convertTablePaste('<table><tr><td colspan="2">A</td></tr></table>', "original\ttext")).toEqual({ markdown: "original\ttext", warning: "merged" });
    expect(convertTablePaste("", "normal text")).toBeNull();
  });
});
