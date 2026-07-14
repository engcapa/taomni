import { describe, expect, it, vi } from "vitest";
import { buildEditorContextMenuItems } from "./editorContextMenu";

const actions = {
  goToDefinition: vi.fn(),
  goToTypeDefinition: vi.fn(),
  goToImplementation: vi.fn(),
  findReferences: vi.fn(),
  callHierarchy: vi.fn(),
  typeHierarchy: vi.fn(),
  rename: vi.fn(),
  quickDocumentation: vi.fn(),
  codeActions: vi.fn(),
  format: vi.fn(),
  cut: vi.fn(),
  copy: vi.fn(),
  paste: vi.fn(),
};

describe("buildEditorContextMenuItems", () => {
  it("disables LSP actions when the language service is unavailable", () => {
    const items = buildEditorContextMenuItems({
      capabilities: null,
      hasSelection: false,
      clientX: 10,
      clientY: 20,
      actions,
      lspAvailable: false,
    });
    const definition = items.find((item) => item.testId === "editor-context-goto-definition");
    const paste = items.find((item) => item.testId === "editor-context-paste");
    expect(definition?.disabled).toBe(true);
    expect(paste?.disabled).toBeFalsy();
  });

  it("gates hierarchy and rename by server capabilities", () => {
    const items = buildEditorContextMenuItems({
      capabilities: {
        definition: true,
        typeDefinition: false,
        implementation: true,
        references: true,
        callHierarchy: false,
        typeHierarchy: true,
        rename: false,
        hover: true,
        codeAction: true,
        formatting: true,
        rangeFormatting: false,
      },
      hasSelection: true,
      clientX: 1,
      clientY: 2,
      actions,
      lspAvailable: true,
    });

    expect(items.find((i) => i.testId === "editor-context-goto-definition")?.disabled).toBe(false);
    expect(items.find((i) => i.testId === "editor-context-goto-type-definition")?.disabled).toBe(true);
    expect(items.find((i) => i.testId === "editor-context-call-hierarchy")?.disabled).toBe(true);
    expect(items.find((i) => i.testId === "editor-context-type-hierarchy")?.disabled).toBe(false);
    expect(items.find((i) => i.testId === "editor-context-rename")?.disabled).toBe(true);
    expect(items.find((i) => i.testId === "editor-context-cut")?.disabled).toBe(false);
    expect(items.find((i) => i.testId === "editor-context-format")?.label).toBe("Format Selection");
  });

  it("wires code actions with the click coordinates", () => {
    const items = buildEditorContextMenuItems({
      capabilities: { codeAction: true },
      hasSelection: false,
      clientX: 42,
      clientY: 84,
      actions,
      lspAvailable: true,
    });
    items.find((i) => i.testId === "editor-context-code-actions")?.onClick?.();
    expect(actions.codeActions).toHaveBeenCalledWith(42, 84);
  });
});
