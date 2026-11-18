import type { EditorView } from "@codemirror/view";
import { openExternalUrl } from "../../../lib/sftp";
import { enhanceMarkdown, markdownFragment } from "./markdownRender";
import type { MarkdownWidgetContext, WidgetEdit } from "./markdownWidgetContext";

interface CellOptions {
  context: MarkdownWidgetContext;
  source: () => string;
  commit: (source: string, edit: WidgetEdit) => boolean;
  activate: () => void;
}

/** Own a cell's rendered/editable DOM, including IME and async image lifetime. */
export class TableCell {
  private editing = false;
  private committing = false;
  private firstChange = true;
  private composing = false;
  private compositionSource = "";
  private renderedSource: string | undefined;
  private generation = 0;
  private destroyed = false;

  constructor(private cell: HTMLElement, private view: EditorView, private options: CellOptions) {
    cell.onclick = (event) => {
      const anchor = event.target instanceof Element ? event.target.closest("a") : null;
      if (!anchor) return;
      event.preventDefault();
      event.stopPropagation();
      const href = anchor.getAttribute("href") || "";
      if (/^(https?:|mailto:)/i.test(href)) void openExternalUrl(href).catch((error: unknown) => {
        if (!this.destroyed) options.context.onError(String(error));
      });
    };
    this.sync();
    if (options.context.readOnly) return;
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
      if (this.compositionSource === options.source()) this.commit("input.type.compose.start");
      else options.context.onError(options.context.label("单元格已更改，请重新输入", "Cell changed; please enter the text again"));
      this.sync();
    });
    cell.oninput = (event) => {
      if (!this.composing) this.commit((event as InputEvent).inputType?.startsWith("delete") ? "delete" : "input.type");
    };
    cell.onpaste = (event) => this.paste(event);
    cell.addEventListener("keydown", (event) => this.selectAll(event));
    cell.onmousedown = (event) => {
      // Keep the rendered anchor alive until click instead of focusing the
      // editable cell and replacing it with source on pointer down.
      if (event.target instanceof Element && event.target.closest("a")) event.preventDefault();
    };
  }

  private edit(): void {
    if (this.options.context.readOnly || this.editing) return;
    this.editing = true;
    this.firstChange = true;
    this.generation++;
    this.renderedSource = undefined;
    this.cell.textContent = this.options.source();
  }

  private commit(userEvent: string): void {
    if (this.destroyed || this.options.context.readOnly) return;
    this.committing = true;
    try {
      const isolate = userEvent === "input.paste" ? "full" : this.firstChange ? "before" : undefined;
      if (this.options.commit(this.cell.textContent || "", { userEvent, isolate })) this.firstChange = false;
    } finally { this.committing = false; }
  }

  private selectAll(event: KeyboardEvent): void {
    if (this.destroyed || !this.editing || this.options.context.readOnly || this.composing || event.isComposing
      || document.activeElement !== this.cell || event.altKey || event.shiftKey || event.key.toLowerCase() !== "a") return;
    const mac = /Mac/i.test(navigator.platform);
    if (!(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return;
    const selection = window.getSelection();
    if (!selection) return;
    event.preventDefault();
    event.stopPropagation();
    selection.selectAllChildren(this.cell);
  }

  sync(): void {
    // Parsing trims GFM padding. Echoing that normalization during an owned
    // keystroke removes a just-typed space and resets the live DOM caret.
    if (this.destroyed || this.composing || this.committing) return;
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
    if (!this.composing) this.commit("input.paste");
  }

  destroy(): void { this.destroyed = true; this.generation++; }
}
