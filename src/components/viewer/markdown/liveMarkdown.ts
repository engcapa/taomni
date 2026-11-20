import { StateField, Transaction, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { Tokens } from "marked";
import { openExternalUrl } from "../../../lib/sftp";
import { markdownBlocks, standaloneImage, tableFromToken } from "./markdownModel";
import { TableWidget } from "./TableWidget";
import { ImageWidget } from "./ImageWidget";
import { enhanceMarkdown, markdownFragment } from "./markdownRender";
import { replaceWidgetSource, revealSource, type MarkdownWidgetContext } from "./markdownWidgetContext";

const owners = new WeakMap<HTMLElement, { cancelled: boolean }>();

class RenderedBlock extends WidgetType {
  constructor(readonly from: number, readonly raw: string, readonly context: MarkdownWidgetContext) { super(); }
  eq(other: RenderedBlock): boolean { return this.from === other.from && this.raw === other.raw && this.context === other.context; }
  ignoreEvent(event: Event): boolean {
    // In browse mode the WebView selects and copies the rendered text. A
    // CodeMirror selection would map each block to its underlying source span.
    if (this.context.readOnly) return true;
    // Diagram actions own their pointer/keyboard lifecycle. Letting CodeMirror
    // handle right-button mouseup moves the caret into this block and removes
    // the widget while its portal menu is receiving focus.
    return event.target instanceof Element && Boolean(event.target.closest(".fv-md-mermaid,.fv-md-drawio,.fv-md-drawio-source"));
  }
  destroy(dom: HTMLElement): void { const owner = owners.get(dom); if (owner) owner.cancelled = true; }
  toDOM(view: EditorView): HTMLElement {
    const root = markdownFragment(this.raw);
    root.className = "fv-md-rendered-block";
    root.dataset.markdownBlockFrom = String(this.from);
    root.dataset.markdownBlockLength = String(this.raw.length);
    const owner = { cancelled: false };
    owners.set(root, owner);
    // Start image resolution while detached; it strips network/path src values
    // synchronously before the node is inserted by CodeMirror.
    void enhanceMarkdown(root, { docPath: this.context.docPath, theme: this.context.theme, readImage: this.context.readImage, cancelled: () => owner.cancelled,
      onWarning: this.context.onWarning, label: this.context.label,
      onResize: () => { if (!owner.cancelled) view.requestMeasure(); } }).catch((error: unknown) => {
      if (!owner.cancelled) this.context.onError(String(error));
    });
    const tasks = [...this.raw.matchAll(/^(\s*[-+*]\s+)\[([ xX])\]/gm)];
    const items = Array.from(root.querySelectorAll("li"));
    let taskIndex = 0;
    items.forEach((item) => {
      const task = tasks[taskIndex];
      if (!task) return;
      // marked strips input via the shared sanitizer; locate the corresponding
      // task by text instead of assigning checkboxes to unrelated list items.
      const text = this.raw.slice((task.index ?? 0) + task[0].length).split("\n")[0].trim().replace(/[*_`]/g, "");
      const labelContent = item.cloneNode(true) as HTMLElement;
      labelContent.querySelectorAll(".fv-md-task-state,ul,ol").forEach((node) => node.remove());
      // restoreMarkdownTasks prefixes passive list items with a checkbox glyph;
      // ignore that presentation marker when matching the source task to its
      // rendered list item.
      const renderedText = (labelContent.textContent || "").trim().replace(/^[☐☑]\s*/, "");
      if (!renderedText.startsWith(text)) return;
      taskIndex++;
      const toggle = document.createElement("button");
      const checked = task[2].toLowerCase() === "x";
      toggle.type = "button";
      toggle.className = `fv-md-task${checked ? " is-checked" : ""}`;
      toggle.textContent = checked ? "✓" : "";
      toggle.setAttribute("role", "checkbox");
      toggle.setAttribute("aria-checked", String(checked));
      toggle.setAttribute("aria-label", text);
      toggle.disabled = this.context.readOnly;
      let handledByPointer = false;
      const toggleTask = (event: Event) => {
        event.stopPropagation(); event.preventDefault();
        const source = view.state.doc.toString();
        const taskStart = source.indexOf(task[0], Math.max(0, this.from - 128));
        const index = (task.index ?? 0) + task[1].length + 1;
        const marker = checked ? "[x]" : "[ ]";
        // `task.index` is relative to this rendered block, so prefer its
        // exact document position. Searching from the block start can select
        // an earlier task when several checklist items share one list block.
        const expectedMarker = this.from + (task.index ?? 0) + task[1].length + 1;
        const expectedStart = expectedMarker - 1;
        const markerStart = source.slice(expectedStart, expectedStart + marker.length) === marker
          ? expectedStart
          : source.indexOf(marker, Math.max(0, this.from - 128));
        const absolute = markerStart >= 0 ? markerStart + 1 : taskStart >= 0 ? taskStart + task[1].length + 1 : this.from + index;
        if (absolute >= 0 && absolute < view.state.doc.length) {
          const next = source.slice(0, absolute) + (checked ? " " : "x") + source.slice(absolute + 1);
          this.context.onChange?.(next);
          view.dispatch({ changes: { from: absolute, to: absolute + 1, insert: checked ? " " : "x" }, annotations: Transaction.userEvent.of("input") });
        } else {
          // Keep compatibility with block tokenizers that include separator
          // newlines in raw while CodeMirror stores them in the next block.
          replaceWidgetSource(view, this.from, this.raw, this.raw.slice(0, index) + (checked ? " " : "x") + this.raw.slice(index + 1));
        }
      };
      // Handle pointer down before CodeMirror moves the caret and replaces the
      // widget DOM. A click listener can otherwise lose its target during the
      // live decoration update.
      toggle.onmousedown = (event) => {
        handledByPointer = true;
        toggleTask(event);
      };
      toggle.onclick = (event) => {
        // Browser pointer activation normally reaches mousedown first. Tests,
        // keyboard activation, and assistive technologies may dispatch click
        // directly, so retain click as a fallback without toggling twice.
        if (!handledByPointer) toggleTask(event);
        handledByPointer = false;
        event.preventDefault();
      };
      item.classList.add("fv-md-task-item");
      if (checked) item.classList.add("is-checked");
      const passive = Array.from(item.children).find((child) => child.classList.contains("fv-md-task-state"));
      if (passive) passive.replaceWith(toggle);
      else item.prepend(toggle);
    });
    root.onclick = (event) => {
      const anchor = (event.target as Element).closest("a");
      if (!anchor) return;
      event.preventDefault(); event.stopPropagation();
      const href = anchor.getAttribute("href") || "";
      if (/^(https?:|mailto:)/i.test(href)) void openExternalUrl(href).catch((error: unknown) => this.context.onError(String(error)));
    };
    root.onmousedown = (event) => {
      if (this.context.readOnly) return;
      if ((event.target as Element).closest("button,a,.fv-md-mermaid,.fv-md-drawio,.fv-md-drawio-source")) return;
      event.preventDefault();
      const text = (event.target as Element).textContent?.trim() || "";
      const index = text ? this.raw.indexOf(text) : -1;
      revealSource(view, this.from + Math.max(0, index));
    };
    return root;
  }
}

function decorations(state: EditorState, context: MarkdownWidgetContext, focus: boolean): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const anchor = state.selection.main.head;
  const currentLine = state.doc.lineAt(anchor);
  const blocks = markdownBlocks(state.doc.toString());
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (!block.raw.trim()) continue;
    const end = block.to - (block.raw.endsWith("\n") ? 1 : 0);
    if (end <= block.from) continue;
    const taskList = block.token.type === "list" && /^\s*[-+*]\s+\[[ xX]\]/m.test(block.raw);
    // Task lists keep their live checkbox while editing. Clicking the text
    // still reveals the source through RenderedBlock.onmousedown, while the
    // checkbox remains directly actionable instead of disappearing as soon as
    // the caret enters that list block.
    const active = !context.readOnly && !taskList && state.selection.ranges.some((range) => range.from <= end && range.to >= block.from);
    const image = standaloneImage(block.token);
    let widget: WidgetType | null = null;
    if (block.token.type === "table") widget = new TableWidget(block.from, block.raw, tableFromToken(block.token as Tokens.Table), context);
    else if (image && !active) widget = new ImageWidget(block.from, block.raw, image, context);
    else if (!active) widget = new RenderedBlock(block.from, block.raw, context);
    if (widget) {
      // The HTML block already owns its paragraph/heading spacing. Leaving
      // Markdown's separator newlines outside a block replacement creates
      // several full-height empty .cm-line nodes between every rendered block.
      // Include only inactive separators; a caret in a blank source line must
      // still get a real editable line, including the final insertion point.
      let replaceTo = block.to;
      for (let next = index + 1; next < blocks.length && !blocks[next].raw.trim(); next++) replaceTo = blocks[next].to;
      if (!context.readOnly) {
        for (const selection of state.selection.ranges) {
          if (selection.from >= block.to && selection.from <= replaceTo) {
            replaceTo = Math.max(block.to, state.doc.lineAt(selection.from).from);
          }
        }
      }
      const endsAtCaretLine = !context.readOnly && state.selection.ranges.some((selection) => state.doc.lineAt(selection.from).from === replaceTo);
      ranges.push(Decoration.replace({ widget, block: true, inclusiveStart: true, inclusiveEnd: !endsAtCaretLine }).range(block.from, replaceTo));
    } else {
      let pos = block.from;
      while (pos <= end) {
        const line = state.doc.lineAt(pos);
        const heading = /^(#{1,6})\s/.exec(line.text);
        const cls = ["fv-md-source-line", line.from === currentLine.from ? "fv-md-current-line" : "",
          heading ? `fv-md-heading-${heading[1].length}` : "",
          focus && line.from !== currentLine.from ? "fv-md-dim" : ""].filter(Boolean).join(" ");
        ranges.push(Decoration.line({ class: cls }).range(line.from));
        if (heading) ranges.push(Decoration.mark({ class: "fv-md-source-marker" }).range(line.from, line.from + heading[0].length));
        if (line.to >= end || line.to === state.doc.length) break;
        pos = line.to + 1;
      }
    }
  }
  // Space tokens are not rendered blocks. Keep the active empty source line
  // visibly editable even when surrounding rendered blocks own their spacing.
  if (!context.readOnly && !currentLine.text.trim() && !ranges.some((range) => range.value.spec.class?.includes("fv-md-current-line"))) {
    ranges.push(Decoration.line({ class: "fv-md-source-line fv-md-current-line" }).range(currentLine.from));
  }
  return Decoration.set(ranges, true);
}

export function liveMarkdown(context: MarkdownWidgetContext, focus: boolean): Extension {
  return [
    StateField.define<DecorationSet>({
      create: (state) => decorations(state, context, focus),
      update: (value, transaction) => transaction.docChanged || transaction.selection
        ? decorations(transaction.state, context, focus) : value,
      provide: (field) => EditorView.decorations.from(field),
    }),
    EditorView.contentAttributes.of({ "data-testid": "markdown-live-content" }),
    EditorView.theme({
      "&": { height: "100%" },
      ".cm-gutters": { display: "none" },
      ".cm-scroller": { fontFamily: "inherit", overflow: "auto" },
      ".cm-content": { maxWidth: "800px", width: "100%", margin: "0 auto", padding: "30px 44px 120px", fontSize: "15px", lineHeight: "1.75", boxSizing: "border-box" },
      ".cm-line": { padding: "0" },
      ".cm-activeLine": { background: "transparent" },
    }),
  ];
}
