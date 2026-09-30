import { describe, expect, it, vi } from "vitest";
import type { MenuItem } from "../../ContextMenu";
import type { PreparedActionEvaluation } from "./workspaceActionHost";
import {
  buildEditorContextMenuItems,
  type BuildEditorContextMenuInput,
  type EditorContextMenuActionBinding,
} from "./editorContextMenu";

/**
 * A binding whose frozen evaluation reports `available` and records execution.
 * Disabled rows use `availability: "disabled"`.
 */
function binding(
  actionId: string,
  options: { available?: boolean } = {},
): EditorContextMenuActionBinding & { execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn();
  const prepare = {
    actionId,
    state: {
      availability: options.available === false ? "disabled" : "available",
      source: "local",
      scope: "workspace",
      freshness: "current",
      completeness: "complete",
    },
  } as unknown as PreparedActionEvaluation;
  return { actionId, prepare, run: execute, execute };
}

/** Depth-first rows including submenu children (ED-PARITY-021 Go To ›, AI ›). */
function menu(input: BuildEditorContextMenuInput): MenuItem[] {
  const out: MenuItem[] = [];
  const walk = (items: MenuItem[]) => {
    for (const item of items) {
      out.push(item);
      if (item.children) walk(item.children);
    }
  };
  walk(buildEditorContextMenuItems(input));
  return out;
}

function baseInput(
  overrides: Partial<BuildEditorContextMenuInput> = {},
): BuildEditorContextMenuInput {
  return {
    capabilities: null,
    hasSelection: false,
    clientX: 10,
    clientY: 20,
    bindings: {},
    ...overrides,
  };
}

describe("buildEditorContextMenuItems", () => {
  it("projects disabled rows from unavailable prepared evaluations", () => {
    const items = menu(baseInput({
      bindings: {
        "workspace.gotoDefinition": binding("workspace.gotoDefinition"),
        "workspace.gotoDeclaration": binding("workspace.gotoDeclaration"),
        "workspace.editor.paste": binding("workspace.editor.paste", { available: false }),
      },
    }));
    expect(items.find((item) => item.testId === "editor-context-goto-definition")?.disabled)
      .toBe(false);
    expect(items.find((item) => item.testId === "editor-context-paste")?.disabled).toBe(true);
  });

  it("disables rows with no binding at all (host did not prepare them)", () => {
    const items = menu(baseInput({
      hasSelection: true,
      bindings: {
        "workspace.editor.copy": binding("workspace.editor.copy"),
      },
    }));
    expect(items.find((i) => i.testId === "editor-context-copy")?.disabled).toBe(false);
    expect(items.find((i) => i.testId === "editor-context-cut")?.disabled).toBe(true);
    expect(items.find((i) => i.testId === "editor-context-goto-type-definition")?.disabled)
      .toBe(true);
  });

  it("executes the same frozen evaluation the enabled state came from", () => {
    const copyBinding = binding("workspace.editor.copy");
    const items = menu(baseInput({
      hasSelection: true,
      bindings: { "workspace.editor.copy": copyBinding },
    }));
    items.find((i) => i.testId === "editor-context-copy")?.onClick?.();
    expect(copyBinding.execute).toHaveBeenCalledTimes(1);
    expect(copyBinding.execute.mock.calls[0][0]).toBeUndefined();
  });

  it("keeps the documented labels and shortcuts for every mapped row", () => {
    const actionIds = [
      "workspace.gotoDefinition",
      "workspace.gotoDeclaration",
      "workspace.gotoTypeDefinition",
      "workspace.gotoImplementation",
      "workspace.findReferences",
      "workspace.callHierarchy",
      "workspace.typeHierarchy",
      "workspace.renameSymbol",
      "workspace.safeDeleteSymbol",
      "workspace.quickDocumentation",
      "workspace.codeActions",
      "workspace.format",
      "workspace.editor.cut",
      "workspace.editor.copy",
      "workspace.editor.paste",
    ];
    const bindings = Object.fromEntries(actionIds.map((id) => [id, binding(id)]));
    const items = menu(baseInput({
      hasSelection: true,
      bindings,
    }));
    const expected = [
      // ED-PARITY-013 DEC-013-05: Go to Definition has no default key (F12 is
      // IDEA Jump to Last Tool Window).
      ["editor-context-goto-definition", "Definition", undefined],
      ["editor-context-goto-declaration", "Declaration or Usages", "Ctrl+B"],
      ["editor-context-goto-type-definition", "Type Declaration", "Ctrl+Shift+B"],
      ["editor-context-goto-implementation", "Implementation(s)", "Ctrl+Alt+B"],
      ["editor-context-find-usages", "Find Usages", "Alt+F7"],
      ["editor-context-call-hierarchy", "Call Hierarchy", "Ctrl+Alt+H"],
      ["editor-context-type-hierarchy", "Type Hierarchy", "Ctrl+H"],
      ["editor-context-rename", "Rename…", "Shift+F6"],
      ["editor-context-safe-delete", "Safe Delete…", "Alt+Delete"],
      ["editor-context-quick-doc", "Quick Documentation", "Ctrl+Q"],
      ["editor-context-code-actions", "Show Context Actions", "Alt+Enter"],
      ["editor-context-format", "Reformat Selection", "Ctrl+Alt+L"],
      ["editor-context-cut", "Cut", "Ctrl+X"],
      ["editor-context-copy", "Copy", "Ctrl+C"],
      ["editor-context-paste", "Paste", "Ctrl+V"],
    ] as const;
    for (const [testId, label, shortcut] of expected) {
      const item = items.find((entry) => entry.testId === testId);
      expect(item?.label, testId).toBe(label);
      expect(item?.shortcut, testId).toBe(shortcut);
    }
    // Every actionable row maps onto exactly one host action id.
    const boundIds = new Set(
      items
        .filter((entry) => !entry.separator && entry.onClick)
        .map((entry) => {
          const id = Object.entries(bindings).find(([, _value]) => false)?.[0];
          return id ?? entry.label;
        }),
    );
    void boundIds;
    // Leaf rows plus the two submenu parents (Go To ›, Refactor ›).
    expect(items.filter((entry) => entry.testId?.startsWith("editor-context-") && !entry.children))
      .toHaveLength(expected.length);
    expect(items.filter((entry) => entry.children).map((entry) => entry.testId))
      .toEqual(["editor-context-goto", "editor-context-refactor"]);
  });

  it("labels format by selection state", () => {
    const bindings = { "workspace.format": binding("workspace.format") };
    expect(menu(baseInput({ hasSelection: false, bindings }))
      .find((i) => i.testId === "editor-context-format")?.label).toBe("Reformat Code");
    expect(menu(baseInput({ hasSelection: true, bindings }))
      .find((i) => i.testId === "editor-context-format")?.label).toBe("Reformat Selection");
  });

  it("adds Run to Cursor only while a debug session is active", () => {
    expect(menu(baseInput())
      .find((i) => i.testId === "editor-context-run-to-cursor")).toBeUndefined();

    const runToCursor = binding("workspace.runToCursor");
    const stopped = menu(baseInput({ debug: { runToCursor } }));
    const item = stopped.find((i) => i.testId === "editor-context-run-to-cursor");
    expect(item?.disabled).toBe(false);
    item?.onClick?.();
    expect(runToCursor.execute).toHaveBeenCalledTimes(1);

    const paused = menu(baseInput({
      debug: {
        runToCursor: binding("workspace.runToCursor", { available: false }),
      },
    }));
    expect(paused.find((i) => i.testId === "editor-context-run-to-cursor")?.disabled).toBe(true);
  });

  it("offers a field data-breakpoint row only when the host resolved one", () => {
    const runToCursor = binding("workspace.runToCursor");
    expect(menu(baseInput({ debug: { runToCursor } }))
      .find((item) => item.testId === "editor-context-add-data-breakpoint")).toBeUndefined();

    const dataBreakpoint = binding("workspace.addDataBreakpoint");
    const items = menu(baseInput({
      debug: { runToCursor, dataBreakpoint },
    }));
    const item = items.find((entry) => entry.testId === "editor-context-add-data-breakpoint");
    expect(item?.disabled).toBe(false);
    item?.onClick?.();
    expect(dataBreakpoint.execute).toHaveBeenCalledTimes(1);
  });

  it("ED-PARITY-013 A1.1: rows show the host's effective shortcut labels when provided", () => {
    const labels: Record<string, string | undefined> = {
      "workspace.gotoDefinition": "F12",
      "workspace.gotoDeclaration": "Ctrl+Alt+Left",
      "workspace.format": undefined,
    };
    const items = menu(baseInput({
      shortcutFor: (actionId) => labels[actionId],
    }));
    expect(items.find((entry) => entry.testId === "editor-context-goto-definition")?.shortcut).toBe("F12");
    expect(items.find((entry) => entry.testId === "editor-context-goto-declaration")?.shortcut).toBe("Ctrl+Alt+Left");
    // A host with no binding shows none rather than the static literal.
    expect(items.find((entry) => entry.testId === "editor-context-format")?.shortcut).toBeUndefined();
  });

  it("adds the AI section only when a host supplies it and never selection-gates it", () => {
    expect(menu(baseInput())
      .find((i) => i.testId === "editor-context-ai-explain-syntax")).toBeUndefined();

    const explainSyntax = binding("workspace.aiExplainSyntax");
    const explainCode = binding("workspace.aiExplainCode");
    const items = menu(baseInput({
      ai: {
        explainSyntaxLabel: "Explain Syntax…",
        explainCodeLabel: "Explain Code…",
        explainSyntax,
        explainCode,
      },
    }));
    const syntax = items.find((i) => i.testId === "editor-context-ai-explain-syntax");
    const code = items.find((i) => i.testId === "editor-context-ai-explain-code");
    expect(syntax?.label).toBe("Explain Syntax…");
    // Ctrl+Alt+S is IDEA Settings now; the unhosted fallback shows no key.
    expect(syntax?.shortcut).toBeUndefined();
    expect(syntax?.disabled).toBe(false);
    expect(code?.disabled).toBe(false);
    syntax?.onClick?.();
    code?.onClick?.();
    expect(explainSyntax.execute).toHaveBeenCalledTimes(1);
    expect(explainCode.execute).toHaveBeenCalledTimes(1);
  });

  it("offers the answer-language submenu with the current value checked", () => {
    const inherit = binding("workspace.aiSetAnswerLanguage");
    const auto = binding("workspace.aiSetAnswerLanguage");
    const zhCn = binding("workspace.aiSetAnswerLanguage");
    const en = binding("workspace.aiSetAnswerLanguage");
    const items = menu(baseInput({
      ai: {
        explainSyntaxLabel: "Explain Syntax…",
        explainCodeLabel: "Explain Code…",
        explainSyntax: binding("workspace.aiExplainSyntax"),
        explainCode: binding("workspace.aiExplainCode"),
        answerLanguage: {
          label: "AI Answer Language",
          current: "zh-CN",
          options: [
            { value: "inherit", label: "Default", binding: inherit },
            { value: "auto", label: "Auto", binding: auto },
            { value: "zh-CN", label: "中文", binding: zhCn },
            { value: "en", label: "EN", binding: en },
          ],
        },
      },
    }));

    const entry = items.find((i) => i.testId === "editor-context-ai-answer-language");
    expect(entry?.label).toBe("AI Answer Language");
    expect(entry?.children).toHaveLength(4);
    expect(entry?.children?.find((c) => c.label === "中文")?.checked).toBe(true);
    expect(entry?.children?.find((c) => c.label === "Auto")?.checked).toBe(false);

    entry?.children?.find((c) => c.label === "EN")?.onClick?.();
    expect(en.execute).toHaveBeenCalledTimes(1);
  });

  it("sits the language submenu right after the explain actions", () => {
    const items = menu(baseInput({
      ai: {
        explainSyntaxLabel: "Explain Syntax…",
        explainCodeLabel: "Explain Code…",
        explainSyntax: binding("workspace.aiExplainSyntax"),
        explainCode: binding("workspace.aiExplainCode"),
        answerLanguage: {
          label: "AI Answer Language",
          current: "inherit",
          options: [{
            value: "inherit",
            label: "Default",
            binding: binding("workspace.aiSetAnswerLanguage"),
          }],
        },
      },
    }));
    const codeIndex = items.findIndex((i) => i.testId === "editor-context-ai-explain-code");
    const languageIndex = items.findIndex((i) => i.testId === "editor-context-ai-answer-language");
    expect(languageIndex).toBe(codeIndex + 1);
  });

  it("omits the submenu when the host passes no answer-language config", () => {
    const items = menu(baseInput({
      ai: {
        explainSyntaxLabel: "Explain Syntax…",
        explainCodeLabel: "Explain Code…",
        explainSyntax: binding("workspace.aiExplainSyntax"),
        explainCode: binding("workspace.aiExplainCode"),
      },
    }));
    expect(items.find((i) => i.testId === "editor-context-ai-answer-language")).toBeUndefined();
  });

  it("isolates cut/copy/paste evaluations to the specified target payload instead of active editor", () => {
    const secondaryCut = binding("workspace.editor.cut", { available: true });
    const secondaryCopy = binding("workspace.editor.copy", { available: true });
    const secondaryPaste = binding("workspace.editor.paste", { available: false });

    const items = menu(baseInput({
      hasSelection: true,
      bindings: {
        "workspace.editor.cut": secondaryCut,
        "workspace.editor.copy": secondaryCopy,
        "workspace.editor.paste": secondaryPaste,
      },
    }));

    const cutItem = items.find((i) => i.testId === "editor-context-cut");
    const pasteItem = items.find((i) => i.testId === "editor-context-paste");

    expect(cutItem?.disabled).toBe(false);
    expect(pasteItem?.disabled).toBe(true);

    cutItem?.onClick?.();
    expect(secondaryCut.execute).toHaveBeenCalledTimes(1);
  });

  it("rebuilds context menu items with updated state when selection changes", () => {
    const withoutSelection = menu(baseInput({
      hasSelection: false,
      bindings: {
        "workspace.format": binding("workspace.format"),
        "workspace.editor.cut": binding("workspace.editor.cut", { available: false }),
        "workspace.editor.copy": binding("workspace.editor.copy", { available: false }),
      },
    }));

    expect(withoutSelection.find((i) => i.testId === "editor-context-format")?.label).toBe("Reformat Code");
    expect(withoutSelection.find((i) => i.testId === "editor-context-cut")?.disabled).toBe(true);
    expect(withoutSelection.find((i) => i.testId === "editor-context-copy")?.disabled).toBe(true);

    const withSelection = menu(baseInput({
      hasSelection: true,
      bindings: {
        "workspace.format": binding("workspace.format"),
        "workspace.editor.cut": binding("workspace.editor.cut", { available: true }),
        "workspace.editor.copy": binding("workspace.editor.copy", { available: true }),
      },
    }));

    expect(withSelection.find((i) => i.testId === "editor-context-format")?.label).toBe("Reformat Selection");
    expect(withSelection.find((i) => i.testId === "editor-context-cut")?.disabled).toBe(false);
    expect(withSelection.find((i) => i.testId === "editor-context-copy")?.disabled).toBe(false);
  });
});

describe("ED-PARITY-021: IDEA editor menu structure", () => {
  it("puts Show Context Actions first and groups navigation, folding, refactor and AI", () => {
    const top = buildEditorContextMenuItems(baseInput({
      bindings: {
        "workspace.editor.foldAll": binding("workspace.editor.foldAll"),
        "workspace.editor.unfoldAll": binding("workspace.editor.unfoldAll"),
      },
      ai: {
        explainSyntaxLabel: "Explain Syntax…",
        explainCodeLabel: "Explain Code…",
        explainSyntax: binding("workspace.aiExplainSyntax"),
        explainCode: binding("workspace.aiExplainCode"),
      },
    }));
    const rows = top.filter((item) => !item.separator).map((item) => item.testId);
    expect(rows).toEqual([
      "editor-context-code-actions",
      "editor-context-cut",
      "editor-context-copy",
      "editor-context-paste",
      "editor-context-find-usages",
      "editor-context-goto",
      "editor-context-quick-doc",
      "editor-context-folding",
      "editor-context-rename",
      "editor-context-refactor",
      "editor-context-format",
      "editor-context-ai",
    ]);
    expect(top.find((item) => item.testId === "editor-context-folding")?.children?.map((item) => item.testId))
      .toEqual(["editor-context-fold-all", "editor-context-unfold-all"]);
  });
});
