import { EditorSelection, Prec, Transaction, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";

export type MarkdownFormat = "bold" | "italic" | "strike" | "code" | "link" | "bullet" | "ordered" | "task" | "quote" | "table" | "codeblock" | "hr" | "formula" | "mermaid";
const markers: Partial<Record<MarkdownFormat, [string, string]>> = {
  bold: ["**", "**"], italic: ["*", "*"], strike: ["~~", "~~"], code: ["`", "`"], link: ["[", "](https://)"],
};

export function formatMarkdown(view: EditorView, action: MarkdownFormat): boolean {
  if (view.state.readOnly) return false;
  const range = view.state.selection.main;
  const selected = view.state.doc.sliceString(range.from, range.to);
  const marker = markers[action];
  if (marker) {
    const [before, after] = marker;
    if (range.from >= before.length && view.state.doc.sliceString(range.from - before.length, range.from) === before &&
      view.state.doc.sliceString(range.to, range.to + after.length) === after) {
      view.dispatch({ changes: [{ from: range.from - before.length, to: range.from, insert: "" }, { from: range.to, to: range.to + after.length, insert: "" }],
        selection: { anchor: range.from - before.length, head: range.to - before.length }, annotations: Transaction.userEvent.of("input") });
    } else {
      const text = selected || (action === "link" ? "link" : "text");
      view.dispatch({ changes: { from: range.from, to: range.to, insert: before + text + after },
        selection: { anchor: range.from + before.length, head: range.from + before.length + text.length }, annotations: Transaction.userEvent.of("input") });
    }
  } else if (["bullet", "ordered", "task", "quote"].includes(action)) {
    const first = view.state.doc.lineAt(range.from), last = view.state.doc.lineAt(range.to);
    const text = view.state.doc.sliceString(first.from, last.to);
    const prefix = action === "bullet" ? "- " : action === "task" ? "- [ ] " : action === "quote" ? "> " : "1. ";
    const lines = text.split("\n");
    const remove = lines.every((line) => line.startsWith(prefix));
    const insert = lines.map((line, index) => remove ? line.slice(prefix.length) : (action === "ordered" ? `${index + 1}. ` : prefix) + line).join("\n");
    view.dispatch({ changes: { from: first.from, to: last.to, insert }, selection: { anchor: first.from, head: first.from + insert.length }, annotations: Transaction.userEvent.of("input") });
  } else {
    const templates: Partial<Record<MarkdownFormat, string>> = {
      table: "| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n",
      codeblock: `\`\`\`\n${selected}\n\`\`\`\n`, hr: "---\n",
      formula: "```math\nE = mc^2\n```\n", mermaid: "```mermaid\nflowchart LR\n  A --> B\n```\n",
    };
    const block = templates[action];
    if (!block) return false;
    const prefix = range.from > 0 && view.state.doc.sliceString(range.from - 1, range.from) !== "\n" ? "\n\n" : "";
    const insert = prefix + block + "\n";
    view.dispatch({ changes: { from: range.from, to: range.to, insert }, selection: EditorSelection.cursor(range.from + insert.length),
      annotations: [Transaction.userEvent.of("input"), isolateHistory.of("full")] });
  }
  view.focus();
  return true;
}

export function setMarkdownHeading(view: EditorView, level: number): void {
  if (view.state.readOnly) return;
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const text = line.text.replace(/^#{1,6}\s+/, "");
  const prefix = level > 0 ? "#".repeat(level) + " " : "";
  view.dispatch({ changes: { from: line.from, to: line.to, insert: prefix + text }, selection: { anchor: line.from + prefix.length + text.length }, annotations: Transaction.userEvent.of("input") });
  view.focus();
}

export function markdownShortcuts(onSave: () => void, onPrint: () => void): Extension {
  return Prec.highest(keymap.of([
    { key: "Mod-b", run: (view) => formatMarkdown(view, "bold") },
    { key: "Mod-i", run: (view) => formatMarkdown(view, "italic") },
    { key: "Mod-k", run: (view) => formatMarkdown(view, "link") },
    { key: "Mod-s", run: () => { onSave(); return true; } },
    { key: "Mod-p", run: () => { onPrint(); return true; } },
  ]));
}
