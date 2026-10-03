import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  inlineRenameField,
  inlineRenameNameError,
  showInlineRenameMarks,
  suggestInlineRenameNames,
} from "./inlineRename";
import { readRefactorOptionsMode, REFACTOR_OPTIONS_STORAGE_KEY, writeRefactorOptionsMode } from "./refactorOptions";

describe("ED-PARITY-017 inline rename helpers", () => {
  it("suggests the name then its camel-case suffixes, keeping type-name capitals", () => {
    expect(suggestInlineRenameNames("stringArrayList")).toEqual(["stringArrayList", "arrayList", "list"]);
    expect(suggestInlineRenameNames("QaOrderTarget")).toEqual(["QaOrderTarget", "OrderTarget", "Target"]);
    expect(suggestInlineRenameNames("extracted")).toEqual(["extracted"]);
  });

  it("rejects empty, whitespace and invalid Java identifiers locally", () => {
    expect(inlineRenameNameError("", "java")).toBe("Enter a name");
    expect(inlineRenameNameError("a b", "java")).toMatch(/not a valid identifier/);
    expect(inlineRenameNameError("9lives", "java")).toMatch(/not a valid identifier/);
    expect(inlineRenameNameError("class", "java")).toMatch(/reserved word/);
    expect(inlineRenameNameError("total", "java")).toBeNull();
    // Non-Java languages leave identifier rules to the provider.
    expect(inlineRenameNameError("kebab-case", "css")).toBeNull();
  });

  it("boxes the target and occurrences without changing the document", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({ state: EditorState.create({ doc: "int sum = sum + 1;" }), parent });
    showInlineRenameMarks(view, { target: { from: 4, to: 7 }, occurrences: [{ from: 4, to: 7 }, { from: 10, to: 13 }] });
    const decorations = view.state.field(inlineRenameField);
    const found: string[] = [];
    decorations.between(0, view.state.doc.length, (from, to, value) => {
      found.push(`${from}-${to}:${String(value.spec.class)}`);
    });
    expect(found).toEqual(["4-7:cm-inline-rename-target", "10-13:cm-inline-rename-occurrence"]);
    expect(view.state.doc.toString()).toBe("int sum = sum + 1;");
    showInlineRenameMarks(view, null);
    expect(view.state.field(inlineRenameField).size).toBe(0);
    view.destroy();
    parent.remove();
  });

  it("persists the refactoring options mode, defaulting to the editor", () => {
    window.localStorage.removeItem(REFACTOR_OPTIONS_STORAGE_KEY);
    expect(readRefactorOptionsMode()).toBe("editor");
    writeRefactorOptionsMode("dialog");
    expect(readRefactorOptionsMode()).toBe("dialog");
    window.localStorage.setItem(REFACTOR_OPTIONS_STORAGE_KEY, "not json");
    expect(readRefactorOptionsMode()).toBe("editor");
    window.localStorage.removeItem(REFACTOR_OPTIONS_STORAGE_KEY);
  });
});
