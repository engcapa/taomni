import { getSearchQuery, searchPanelOpen } from "@codemirror/search";
import { Text as DocumentText } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

interface MatchRanges { all: Range[]; current: Range[] }
const editors = new Map<EditorView, MatchRanges>();

function paintHighlights() {
  if (!globalThis.CSS?.highlights || typeof Highlight === "undefined") return;
  const ranges = Array.from(editors.values());
  if (ranges.length === 0) {
    CSS.highlights.delete("markdown-find-match");
    CSS.highlights.delete("markdown-find-current");
    return;
  }
  CSS.highlights.set("markdown-find-match", new Highlight(...ranges.flatMap((result) => result.all)));
  CSS.highlights.set("markdown-find-current", new Highlight(...ranges.flatMap((result) => result.current)));
}

function renderedMatches(view: EditorView): MatchRanges {
  const result: MatchRanges = { all: [], current: [] };
  const query = getSearchQuery(view.state);
  if (!searchPanelOpen(view.state) || !query.valid) return result;
  const { from: activeFrom, to: activeTo } = view.state.selection.main;
  for (const block of view.contentDOM.querySelectorAll<HTMLElement>("[data-markdown-block-from]")) {
    const blockFrom = Number(block.dataset.markdownBlockFrom);
    const blockTo = Math.min(blockFrom + Number(block.dataset.markdownBlockLength), view.state.doc.length);
    const sourceMatches = query.getCursor(view.state, blockFrom, blockTo);
    const currentIndex = Array.from({ [Symbol.iterator]: () => sourceMatches })
      .findIndex(({ from, to }) => from === activeFrom && to === activeTo);
    const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => node.parentElement?.closest("button,svg,.fv-md-table-tools,.katex-mathml,[contenteditable=true]")
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const parts: { node: Text; from: number; to: number }[] = [];
    let rendered = "";
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (!node.data.length) continue;
      const from = rendered.length;
      rendered += node.data;
      parts.push({ node, from, to: rendered.length });
    }
    let index = 0;
    const renderedCursor = query.getCursor(DocumentText.of(rendered.split("\n")));
    for (const match of { [Symbol.iterator]: () => renderedCursor }) {
      const first = parts.find((part) => part.to > match.from);
      const last = parts.find((part) => part.to >= match.to);
      if (!first || !last || match.from === match.to) continue;
      const range = block.ownerDocument.createRange();
      range.setStart(first.node, match.from - first.from);
      range.setEnd(last.node, match.to - last.from);
      (index++ === currentIndex ? result.current : result.all).push(range);
    }
  }
  return result;
}

/** Keep rendered Live matches visible without altering document or DOM selection. */
export const markdownSearchHighlights = ViewPlugin.fromClass(class {
  private destroyed = false;
  constructor(private readonly view: EditorView) { this.schedule(); }
  update(update: ViewUpdate) {
    if (update.viewportChanged || update.startState !== update.state) this.schedule();
  }
  destroy() {
    this.destroyed = true;
    editors.delete(this.view);
    paintHighlights();
  }
  private schedule() {
    if (!globalThis.CSS?.highlights || typeof Highlight === "undefined") return;
    this.view.requestMeasure({
      key: this,
      read: renderedMatches,
      write: (ranges) => {
        if (this.destroyed) return;
        if (ranges.all.length || ranges.current.length) editors.set(this.view, ranges);
        else editors.delete(this.view);
        paintHighlights();
      },
    });
  }
});
