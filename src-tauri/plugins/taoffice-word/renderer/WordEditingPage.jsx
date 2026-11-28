import { MAX_PARAGRAPH_LENGTH } from "./wordXml.js";
import { wordPageLayout } from "./wordPageLayout.js";

const { React } = globalThis.__taomniHost;

export function WordEditingPage({ document, draft, editor, label, zoom }) {
  const { pages, paper } = React.useMemo(() => wordPageLayout(document), [document]);
  function renderBlock(block, key) {
    if (block.kind === "table") return <table key={key}>
      <tbody>{block.rows.map((row, index) => <tr key={index}>{row.map((cell, col) =>
        <td key={col} colSpan={cell.span}>{cell.blocks.map(renderBlock)}</td>)}</tr>)}</tbody>
    </table>;
    const { paragraph, heading, align } = block;
    if (!paragraph) return <p key={key} style={{ textAlign: align }}>{block.text || "\u00a0"}</p>;
    const value = draft.edits.get(paragraph.id) ?? paragraph.text;
    const name = paragraph.tableDepth ? label("表格单元格段落", "Table cell paragraph") : label("正文段落", "Body paragraph");
    return <label key={key} className="taoffice-word-line" data-heading={heading} style={{ textAlign: align }}>
      <span aria-hidden="true">{value + "\u200b"}</span>
      <textarea data-testid="taoffice-word-paragraph" data-index={paragraph.id} rows={1}
        data-location={paragraph.tableDepth ? "table" : "body"} ref={paragraph.id === 0 ? editor : undefined}
        aria-label={name + " " + (paragraph.id + 1)} value={value} maxLength={MAX_PARAGRAPH_LENGTH} disabled={draft.saving}
        onKeyDown={event => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) event.preventDefault();
        }}
        onChange={event => draft.edit(paragraph.id, event.target.value.replace(/[\r\n\t]+/g, " "), paragraph.text)} />
    </label>;
  }
  return <div className="taoffice-word-edit-surface" data-testid="taoffice-word-editor">
    {pages.map((blocks, index) => <article key={index} className="taoffice-word-sheet"
      aria-label={label("第 " + (index + 1) + " 页", "Page " + (index + 1))} style={{ ...paper, zoom }}>
      {blocks.map(renderBlock)}
    </article>)}
  </div>;
}
