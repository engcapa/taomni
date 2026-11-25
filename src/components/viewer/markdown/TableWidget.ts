import { EditorView, WidgetType, runScopeHandlers } from "@codemirror/view";
import { type MarkdownTable, modifyTable, serializeTable } from "./markdownModel";
import { replaceWidgetSource, widgetButton, type MarkdownWidgetContext, type WidgetEdit } from "./markdownWidgetContext";
import { TableCell } from "./TableCell";

interface Runtime { widget: TableWidget; cells: Map<HTMLElement, TableCell> }
const runtimes = new WeakMap<HTMLElement, Runtime>();

export class TableWidget extends WidgetType {
  constructor(readonly from: number, readonly raw: string, readonly table: MarkdownTable, readonly context: MarkdownWidgetContext) { super(); }
  eq(other: TableWidget): boolean { return this.from === other.from && this.raw === other.raw && this.context === other.context; }
  ignoreEvent(): boolean { return true; }
  destroy(dom: HTMLElement): void {
    runtimes.get(dom)?.cells.forEach((cell) => cell.destroy());
    runtimes.delete(dom);
  }

  updateDOM(dom: HTMLElement): boolean {
    const runtime = runtimes.get(dom);
    if (!runtime || runtime.widget.context !== this.context || runtime.widget.table.rows.length !== this.table.rows.length || runtime.widget.table.align.length !== this.table.align.length) return false;
    runtime.widget = this;
    dom.dataset.tableFrom = String(this.from);
    dom.dataset.markdownBlockFrom = String(this.from);
    dom.dataset.markdownBlockLength = String(this.raw.length);
    dom.querySelectorAll<HTMLElement>("[data-cell-row]").forEach((cell) => {
      const column = Number(cell.dataset.cellColumn);
      runtime.cells.get(cell)?.sync();
      cell.style.textAlign = this.table.align[column] || "left";
    });
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement("div");
    root.className = "fv-md-table-wrap";
    root.dataset.testid = "markdown-table-widget";
    root.dataset.tableFrom = String(this.from);
    root.dataset.markdownBlockFrom = String(this.from);
    root.dataset.markdownBlockLength = String(this.raw.length);
    const runtime: Runtime = { widget: this, cells: new Map() };
    runtimes.set(root, runtime);
    const label = this.context.label;
    let activeRow = 0, activeColumn = 0;
    const focusCell = (row: number, column: number) => requestAnimationFrame(() => {
      const container = view.dom.querySelector<HTMLElement>(`[data-table-from="${runtime.widget.from}"]`);
      container?.querySelector<HTMLElement>(`[data-cell-row="${row}"][data-cell-column="${column}"]`)?.focus();
    });
    const commit = (next: MarkdownTable, edit?: WidgetEdit) => {
      const current = runtime.widget;
      return replaceWidgetSource(view, current.from, current.raw, serializeTable(next), edit);
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
    this.table.rows.forEach((_, rowIndex) => {
      const row = document.createElement("tr");
      Array.from({ length: this.table.align.length }, (_, columnIndex) => {
        const cell = document.createElement(rowIndex ? "td" : "th");
        cell.setAttribute("contenteditable", this.context.readOnly ? "false" : "true");
        cell.dataset.cellRow = String(rowIndex);
        cell.dataset.cellColumn = String(columnIndex);
        cell.style.textAlign = this.table.align[columnIndex] || "left";
        row.append(cell);
        const activate = () => {
          activeRow = rowIndex; activeColumn = columnIndex;
          root.querySelectorAll(".is-active").forEach((node) => node.classList.remove("is-active"));
          cell.classList.add("is-active");
          root.classList.add("is-active");
        };
        runtime.cells.set(cell, new TableCell(cell, view, { context: this.context, activate,
          source: () => runtime.widget.table.rows[rowIndex]?.[columnIndex] ?? "",
          commit: (source, edit) => {
            const current = runtime.widget.table;
            const rows = current.rows.map((cells) => [...cells]);
            if (rows[rowIndex][columnIndex] === source) return false;
            rows[rowIndex][columnIndex] = source;
            return commit({ rows, align: current.align }, edit);
          } }));
        if (this.context.readOnly) return;
        cell.spellcheck = false;
        cell.tabIndex = 0;
        cell.setAttribute("aria-label", label(`第 ${rowIndex + 1} 行，第 ${columnIndex + 1} 列`, `Row ${rowIndex + 1}, column ${columnIndex + 1}`));
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
      });
      (rowIndex ? body : head).append(row);
    });
    table.append(head, body);
    if (!this.context.readOnly) root.append(tools);
    root.append(table);
    root.addEventListener("focusout", () => queueMicrotask(() => { if (!root.contains(document.activeElement)) root.classList.remove("is-active"); }));
    return root;
  }
}
