import type { EditorView } from "@codemirror/view";
import { openExternalUrl } from "../../../lib/sftp";
import { enhanceMarkdown, markdownFragment } from "./markdownRender";
import type { MarkdownWidgetContext } from "./markdownWidgetContext";

interface CellOptions {
  context: MarkdownWidgetContext;
  source: () => string;
  commit: (source: string) => void;
  activate: () => void;
}

/** Own a cell's rendered/editable DOM, including IME and async image lifetime. */
export class TableCell {
  private editing = false;
  private composing = false;
  private compositionSource = "";
  private renderedSource: string | undefined;
  private generation = 0;
  private destroyed = false;

  constructor(private cell: HTMLElement, private view: EditorView, private options: CellOptions) {
    cell.onfocus = () => { options.activate(); this.edit(); };
    cell.onblur = () => { this.editing = false; if (!this.composing) this.sync(); };
    cell.addEventListener("compositionstart", () => {
      this.edit();
      this.composing = true;
      this.compositionSource = options.source();
    });
    cell.addEventListener("compositionend", () => {
      this.composing = false;
      // Never overwrite a concurrent change to this cell with stale IME text.
      if (this.compositionSource === options.source()) this.commit();
      else options.context.onError(options.context.label("单元格已更改，请重新输入", "Cell changed; please enter the text again"));
      this.sync();
    });
    cell.oninput = () => { if (!this.composing) this.commit(); };
    cell.onpaste = (event) => this.paste(event);
    cell.onmousedown = (event) => {
      // Keep the rendered anchor alive until click instead of focusing the
      // editable cell and replacing it with source on pointer down.
      if ((event.target as Element).closest("a")) event.preventDefault();
    };
    cell.onclick = (event) => {
      const anchor = (event.target as Element).closest("a");
      if (!anchor) return;
      event.preventDefault(); event.stopPropagation();
      const href = anchor.getAttribute("href") || "";
      if (/^(https?:|mailto:)/i.test(href)) void openExternalUrl(href).catch((error: unknown) => {
        if (!this.destroyed) options.context.onError(String(error));
      });
    };
    this.sync();
  }

  private edit(): void {
    if (this.options.context.readOnly || this.editing) return;
    this.editing = true;
    this.generation++;
    this.renderedSource = undefined;
    this.cell.textContent = this.options.source();
  }

  private commit(): void {
    if (!this.options.context.readOnly) this.options.commit(this.cell.textContent || "");
  }

  sync(): void {
    if (this.destroyed || this.composing) return;
    const source = this.options.source();
    if (this.editing) {
      if (this.cell.textContent !== source) this.cell.textContent = source;
      return;
    }
    if (source === this.renderedSource) return;
    this.renderedSource = source;
    const generation = ++this.generation;
    const cancelled = () => this.destroyed || generation !== this.generation;
    const fragment = markdownFragment(source, true);
    const rendering = enhanceMarkdown(fragment, { ...this.options.context, cancelled,
      onResize: () => { if (!cancelled()) this.view.requestMeasure(); } });
    this.cell.replaceChildren(...fragment.childNodes);
    void rendering.catch((error: unknown) => { if (!cancelled()) this.options.context.onError(String(error)); });
    this.view.requestMeasure();
  }

  private paste(event: ClipboardEvent): void {
    event.preventDefault();
    if (this.options.context.readOnly) return;
    this.edit();
    const text = event.clipboardData?.getData("text/plain") || "";
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (range && this.cell.contains(range.commonAncestorContainer)) {
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node); range.setStartAfter(node); range.collapse(true);
      selection?.removeAllRanges(); selection?.addRange(range);
    } else this.cell.textContent = text;
    if (!this.composing) this.commit();
  }

  destroy(): void { this.destroyed = true; this.generation++; }
}
