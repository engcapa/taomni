import type { MenuItem } from "../../ContextMenu";
import type { LspCapabilitySummary } from "../../../lib/editor/lsp";
import type { PreparedActionEvaluation } from "./workspaceActionHost";

export interface EditorContextMenuCapabilities {
  definition?: boolean;
  declaration?: boolean;
  typeDefinition?: boolean;
  implementation?: boolean;
  references?: boolean;
  callHierarchy?: boolean;
  typeHierarchy?: boolean;
  rename?: boolean;
  hover?: boolean;
  codeAction?: boolean;
  formatting?: boolean;
  rangeFormatting?: boolean;
}

/**
 * Host-owned execution channel for one context-menu invocation. Every
 * actionable row carries the prepared evaluation captured when the menu
 * opened, so clicking runs exactly what the enabled state was computed from.
 */
export interface EditorContextMenuActionBinding {
  /** Runtime workspace action id (e.g. `workspace.gotoDefinition`). */
  actionId: string;
  /** Frozen evaluation from menu-open time; executed on click. */
  prepare: PreparedActionEvaluation | null;
  /** Runs the frozen evaluation through the owning host. */
  run: () => void;
}

/** AI entry points. Omitted entirely when AI is unavailable/disabled. */
export interface EditorContextMenuAiSection {
  explainSyntaxLabel: string;
  explainCodeLabel: string;
  explainSyntax: EditorContextMenuActionBinding;
  explainCode: EditorContextMenuActionBinding;
  /**
   * Answer-language picker. Present here as well as on the selection toolbar
   * because the context menu is reachable without a selection, and was
   * previously the one path with no way to change the language.
   */
  answerLanguage?: {
    label: string;
    current: string;
    options: Array<{ value: string; label: string; binding: EditorContextMenuActionBinding }>;
  };
}

/**
 * Static metadata + snapshot availability per row. The builder maps these onto
 * MenuItem entries whose `disabled` flag comes only from ActionState, so the
 * menu can never disagree with the host evaluation it executes.
 */
interface RowSpec {
  testId: string;
  label: string;
  shortcut?: string;
  binding: EditorContextMenuActionBinding;
}

function rowFromSpec(spec: RowSpec): MenuItem {
  return {
    label: spec.label,
    shortcut: spec.shortcut,
    testId: spec.testId,
    disabled: !spec.binding.prepare || spec.binding.prepare.state.availability !== "available",
    onClick: () => spec.binding.run(),
  };
}

export interface BuildEditorContextMenuInput {
  capabilities: EditorContextMenuCapabilities | LspCapabilitySummary | null | undefined;
  hasSelection: boolean;
  clientX: number;
  clientY: number;
  /**
   * Prepared host evaluations keyed by runtime action id. Availability of each
   * row comes from its ActionState; clicking executes the same evaluation.
   */
  bindings: Record<string, EditorContextMenuActionBinding | undefined>;
  /** Present while a debug session is active — adds Run to Cursor (IDEA Alt+F9). */
  debug?: {
    runToCursor: EditorContextMenuActionBinding;
    /** Present only when the caret is on a recognized field declaration. */
    dataBreakpoint?: EditorContextMenuActionBinding;
  } | null;
  /** Present when AI is available — adds the Explain Syntax / Explain Code pair. */
  ai?: EditorContextMenuAiSection | null;
  /**
   * Effective shortcut label for an action (ED-PARITY-013 A1.1). When present
   * every row shows the same formatted binding as Keymap/Search Everywhere,
   * including "no shortcut"; the literals below are only the unhosted fallback.
   */
  shortcutFor?: (actionId: string) => string | undefined;
}

function rowShortcut(input: BuildEditorContextMenuInput, actionId: string, fallback: string | undefined): string | undefined {
  return input.shortcutFor ? input.shortcutFor(actionId) : fallback;
}

function bindRow(
  testId: string,
  label: string,
  shortcut: string | undefined,
  actionId: string,
  input: BuildEditorContextMenuInput,
): MenuItem {
  const binding = input.bindings[actionId];
  return rowFromSpec({
    testId,
    label,
    shortcut: rowShortcut(input, actionId, shortcut),
    binding: binding ?? { actionId, prepare: null, run: () => {} },
  });
}

/**
 * Build the editor symbol / buffer context menu as a pure projection of
 * prepared host evaluations (IDEA-style). Pure helper so unit tests do not
 * need CodeMirror or React; execution goes through the frozen evaluations.
 */
export function buildEditorContextMenuItems(input: BuildEditorContextMenuInput): MenuItem[] {
  const { hasSelection } = input;

  const debugItems: MenuItem[] = input.debug
    ? [
      { separator: true, label: "" },
      rowFromSpec({
        testId: "editor-context-run-to-cursor",
        label: "Run to Cursor",
        shortcut: rowShortcut(input, input.debug.runToCursor.actionId, "Alt+F9"),
        binding: input.debug.runToCursor,
      }),
      ...(input.debug.dataBreakpoint
        ? [rowFromSpec({
          testId: "editor-context-add-data-breakpoint",
          label: "Add Data Breakpoint",
          binding: input.debug.dataBreakpoint,
        })]
        : []),
    ]
    : [];

  // AI actions work without a selection (they fall back to the enclosing symbol
  // at the caret), so these are never capability- or selection-gated.
  // ED-PARITY-021 DEC-021-01: they live in one "AI" submenu in the last group.
  const answerLanguage = input.ai?.answerLanguage;
  const aiItems: MenuItem[] = input.ai
    ? [
      { separator: true, label: "" },
      {
        label: "AI",
        testId: "editor-context-ai",
        children: [
          rowFromSpec({
            testId: "editor-context-ai-explain-syntax",
            label: input.ai.explainSyntaxLabel,
            shortcut: rowShortcut(input, input.ai.explainSyntax.actionId, undefined),
            binding: input.ai.explainSyntax,
          }),
          rowFromSpec({
            testId: "editor-context-ai-explain-code",
            label: input.ai.explainCodeLabel,
            shortcut: rowShortcut(input, input.ai.explainCode.actionId, "Ctrl+Alt+E"),
            binding: input.ai.explainCode,
          }),
          ...(answerLanguage
            ? [{
              label: answerLanguage.label,
              testId: "editor-context-ai-answer-language",
              children: answerLanguage.options.map((option) => ({
                label: option.label,
                testId: `editor-context-ai-answer-language-${option.value}`,
                checked: option.value === answerLanguage.current,
                disabled: !option.binding.prepare
                  || option.binding.prepare.state.availability !== "available",
                onClick: () => option.binding.run(),
              })),
            }]
            : []),
        ],
      },
    ]
    : [];

  // ED-PARITY-021 DEC-021-01: IDEA editor menu order — context actions first,
  // then clipboard, navigation (Go To ›), folding, refactoring, debug, AI.
  const optionalRow = (testId: string, label: string, shortcut: string | undefined, actionId: string): MenuItem[] => (
    input.bindings[actionId] ? [bindRow(testId, label, shortcut, actionId, input)] : []
  );
  const foldingChildren = [
    ...optionalRow("editor-context-fold-all", "Collapse All", "Ctrl+Shift+-", "workspace.editor.foldAll"),
    ...optionalRow("editor-context-unfold-all", "Expand All", "Ctrl+Shift+=", "workspace.editor.unfoldAll"),
  ];
  return [
    bindRow("editor-context-code-actions", "Show Context Actions", "Alt+Enter", "workspace.codeActions", input),
    { separator: true, label: "" },
    bindRow("editor-context-cut", "Cut", "Ctrl+X", "workspace.editor.cut", input),
    bindRow("editor-context-copy", "Copy", "Ctrl+C", "workspace.editor.copy", input),
    bindRow("editor-context-paste", "Paste", "Ctrl+V", "workspace.editor.paste", input),
    { separator: true, label: "" },
    bindRow("editor-context-find-usages", "Find Usages", "Alt+F7", "workspace.findReferences", input),
    {
      label: "Go To",
      testId: "editor-context-goto",
      children: [
        bindRow("editor-context-goto-declaration", "Declaration or Usages", "Ctrl+B", "workspace.gotoDeclaration", input),
        bindRow("editor-context-goto-definition", "Definition", undefined, "workspace.gotoDefinition", input),
        bindRow("editor-context-goto-implementation", "Implementation(s)", "Ctrl+Alt+B", "workspace.gotoImplementation", input),
        bindRow("editor-context-goto-type-definition", "Type Declaration", "Ctrl+Shift+B", "workspace.gotoTypeDefinition", input),
        { separator: true, label: "" },
        bindRow("editor-context-call-hierarchy", "Call Hierarchy", "Ctrl+Alt+H", "workspace.callHierarchy", input),
        bindRow("editor-context-type-hierarchy", "Type Hierarchy", "Ctrl+H", "workspace.typeHierarchy", input),
      ],
    },
    bindRow("editor-context-quick-doc", "Quick Documentation", "Ctrl+Q", "workspace.quickDocumentation", input),
    ...(foldingChildren.length > 0
      ? [{ label: "Folding", testId: "editor-context-folding", children: foldingChildren }]
      : []),
    { separator: true, label: "" },
    bindRow("editor-context-rename", "Rename…", "Shift+F6", "workspace.renameSymbol", input),
    {
      label: "Refactor",
      testId: "editor-context-refactor",
      children: [
        bindRow("editor-context-safe-delete", "Safe Delete…", "Alt+Delete", "workspace.safeDeleteSymbol", input),
      ],
    },
    bindRow(
      "editor-context-format",
      hasSelection ? "Reformat Selection" : "Reformat Code",
      "Ctrl+Alt+L",
      "workspace.format",
      input,
    ),
    ...debugItems,
    ...aiItems,
  ];
}
