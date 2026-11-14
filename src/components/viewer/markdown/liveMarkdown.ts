import { StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
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
  ignoreEvent(): boolean { return false; }
  destroy(dom: HTMLElement): void { const owner = owners.get(dom); if (owner) owner.cancelled = true; }
  toDOM(view: EditorView): HTMLElement {
    const root = markdownFragment(this.raw);
    root.className = "fv-md-rendered-block";
    const owner = { cancelled: false };
    owners.set(root, owner);
    // Start image resolution while detached; it strips network/path src values
    // synchronously before the node is inserted by CodeMirror.
    void enhanceMarkdown(root, { docPath: this.context.docPath, cancelled: () => owner.cancelled,
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
      if (!(labelContent.textContent || "").trim().startsWith(text)) return;
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
      toggle.onclick = (event) => {
        event.stopPropagation(); event.preventDefault();
        const index = (task.index ?? 0) + task[1].length + 1;
        replaceWidgetSource(view, this.from, this.raw, this.raw.slice(0, index) + (checked ? " " : "x") + this.raw.slice(index + 1));
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
      if ((event.target as Element).closest("button,a")) return;
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
    const active = state.selection.ranges.some((range) => range.from <= end && range.to >= block.from);
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
      for (const selection of state.selection.ranges) {
        if (selection.from >= block.to && selection.from <= replaceTo) {
          replaceTo = Math.max(block.to, state.doc.lineAt(selection.from).from);
        }
      }
      const endsAtCaretLine = state.selection.ranges.some((selection) => state.doc.lineAt(selection.from).from === replaceTo);
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
  if (!currentLine.text.trim() && !ranges.some((range) => range.value.spec.class?.includes("fv-md-current-line"))) {
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
