import { EditorView, WidgetType, runScopeHandlers } from "@codemirror/view";
import { type MarkdownTable, modifyTable, serializeTable } from "./markdownModel";
import { replaceWidgetSource, widgetButton, type MarkdownWidgetContext } from "./markdownWidgetContext";

interface Runtime { widget: TableWidget }
const runtimes = new WeakMap<HTMLElement, Runtime>();

export class TableWidget extends WidgetType {
  constructor(readonly from: number, readonly raw: string, readonly table: MarkdownTable, readonly context: MarkdownWidgetContext) { super(); }
  eq(other: TableWidget): boolean { return this.from === other.from && this.raw === other.raw && this.context === other.context; }
  ignoreEvent(): boolean { return true; }

  updateDOM(dom: HTMLElement): boolean {
    const runtime = runtimes.get(dom);
    if (!runtime || runtime.widget.context !== this.context || runtime.widget.table.rows.length !== this.table.rows.length || runtime.widget.table.align.length !== this.table.align.length) return false;
    runtime.widget = this;
    dom.dataset.tableFrom = String(this.from);
    dom.querySelectorAll<HTMLElement>("[data-cell-row]").forEach((cell) => {
      const row = Number(cell.dataset.cellRow), column = Number(cell.dataset.cellColumn);
      if (cell.textContent !== this.table.rows[row]?.[column]) cell.textContent = this.table.rows[row]?.[column] ?? "";
      cell.style.textAlign = this.table.align[column] || "left";
    });
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement("div");
    root.className = "fv-md-table-wrap";
    root.dataset.testid = "markdown-table-widget";
    root.dataset.tableFrom = String(this.from);
    const runtime: Runtime = { widget: this };
    runtimes.set(root, runtime);
    const label = this.context.label;
    let activeRow = 0, activeColumn = 0;
    const focusCell = (row: number, column: number) => requestAnimationFrame(() => {
      const container = view.dom.querySelector<HTMLElement>(`[data-table-from="${runtime.widget.from}"]`);
      container?.querySelector<HTMLElement>(`[data-cell-row="${row}"][data-cell-column="${column}"]`)?.focus();
    });
    const commit = (next: MarkdownTable) => {
      const current = runtime.widget;
      return replaceWidgetSource(view, current.from, current.raw, serializeTable(next));
    };
    const action = (name: Parameters<typeof modifyTable>[1]) => {
      const next = modifyTable(runtime.widget.table, name, activeRow, activeColumn);
      if (commit(next)) focusCell(Math.min(activeRow, next.rows.length - 1), Math.min(activeColumn, next.align.length - 1));
    };
    const tools = document.createElement("div");
    tools.className = "fv-md-table-tools";
    tools.setAttribute("role", "toolbar");
    tools.setAttribute("aria-label", label("表格操作", "Table actions"));
    const actions: Array<[Parameters<typeof modifyTable>[1], string, string, string]> = [
      ["row-before", "在上方插入行", "Insert row above", "+↑"],
      ["row-after", "在下方插入行", "Insert row below", "+↓"],
      ["column-before", "在左侧插入列", "Insert column left", "+←"],
      ["column-after", "在右侧插入列", "Insert column right", "+→"],
      ["left", "左对齐", "Align left", "⇤"], ["center", "居中", "Align center", "↔"], ["right", "右对齐", "Align right", "⇥"],
      ["delete-row", "删除行", "Delete row", "−行"], ["delete-column", "删除列", "Delete column", "−列"],
    ];
    if (!this.context.readOnly) {
      for (const [name, zh, en, text] of actions) tools.append(widgetButton(label(zh, en), () => action(name), text));
      tools.append(widgetButton(label("删除表格", "Delete table"), () => {
        const current = runtime.widget;
        replaceWidgetSource(view, current.from, current.raw, "");
        view.focus();
      }, "×"));
    }
    const hint = document.createElement("span");
    hint.textContent = label("Tab 下一格", "Tab: next cell");
    tools.append(hint);
    const table = document.createElement("table");
    const head = document.createElement("thead"), body = document.createElement("tbody");
    this.table.rows.forEach((cells, rowIndex) => {
      const row = document.createElement("tr");
      Array.from({ length: this.table.align.length }, (_, columnIndex) => {
        const cell = document.createElement(rowIndex ? "td" : "th");
        cell.textContent = cells[columnIndex] ?? "";
        cell.setAttribute("contenteditable", this.context.readOnly ? "false" : "true");
        cell.spellcheck = false;
        cell.tabIndex = 0;
        cell.dataset.cellRow = String(rowIndex);
        cell.dataset.cellColumn = String(columnIndex);
        cell.style.textAlign = this.table.align[columnIndex] || "left";
        cell.setAttribute("aria-label", label(`第 ${rowIndex + 1} 行，第 ${columnIndex + 1} 列`, `Row ${rowIndex + 1}, column ${columnIndex + 1}`));
        cell.onfocus = () => {
          activeRow = rowIndex; activeColumn = columnIndex;
          root.querySelectorAll(".is-active").forEach((node) => node.classList.remove("is-active"));
          cell.classList.add("is-active");
          root.classList.add("is-active");
        };
        let composing = false;
        const update = () => {
          if (composing || runtime.widget.context.readOnly) return;
          const current = runtime.widget.table;
          const rows = current.rows.map((cells) => [...cells]);
          rows[rowIndex][columnIndex] = cell.textContent || "";
          commit({ rows, align: current.align });
        };
        cell.addEventListener("compositionstart", () => { composing = true; });
        cell.addEventListener("compositionend", () => { composing = false; update(); });
        cell.oninput = update;
        cell.onpaste = (event) => {
          event.preventDefault();
          const text = event.clipboardData?.getData("text/plain") || "";
          const selection = window.getSelection();
          const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
          if (range && cell.contains(range.commonAncestorContainer)) {
            range.deleteContents();
            const node = document.createTextNode(text);
            range.insertNode(node); range.setStartAfter(node); range.collapse(true);
            selection?.removeAllRanges(); selection?.addRange(range);
          } else cell.textContent = text;
          update();
        };
        cell.onkeydown = (event) => {
          if (event.isComposing) return;
          if ((event.ctrlKey || event.metaKey) && ["z", "y", "s", "p"].includes(event.key.toLowerCase()) && runScopeHandlers(view, event, "editor")) {
            event.preventDefault(); return;
          }
          if (event.key === "Escape") { event.preventDefault(); view.focus(); return; }
          if (event.key !== "Tab" && event.key !== "Enter") return;
          event.preventDefault();
          const current = runtime.widget.table;
          const columns = current.align.length;
          let index = rowIndex * columns + columnIndex + (event.shiftKey ? -1 : event.key === "Enter" ? columns : 1);
          if (index < 0) { view.focus(); return; }
          if (index >= current.rows.length * columns && !runtime.widget.context.readOnly) {
            commit({ rows: [...current.rows, Array(columns).fill("")], align: current.align });
          }
          index = Math.min(index, (runtime.widget.table.rows.length + 1) * columns - 1);
          focusCell(Math.floor(index / columns), index % columns);
        };
        row.append(cell);
      });
      (rowIndex ? body : head).append(row);
    });
    table.append(head, body);
    root.append(tools, table);
    root.addEventListener("focusout", () => queueMicrotask(() => { if (!root.contains(document.activeElement)) root.classList.remove("is-active"); }));
    return root;
  }
}
