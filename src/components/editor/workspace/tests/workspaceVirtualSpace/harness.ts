import { EditorSelection, EditorState, type SelectionRange } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { vi } from "vitest";
import { editorVirtualSpacePolicy } from "../../workspaceEditorCommands";
import { virtualSpaceClickHandler, virtualSpaceOverflowField, virtualSpaceTypingHandler, visualColumnFor } from "../../workspaceVirtualSpace";

export const POLICY = editorVirtualSpacePolicy.of({ afterLineEnd: true, atFileBottom: true });

export function visualColumnOf(text: string, column: number, tabWidth: number): number {
  return visualColumnFor(text, column, tabWidth);
}

export function installPhysicalLineVerticalGeometry(view: EditorView, lineHeight: number) {
  const moveVertically = vi.fn((start: SelectionRange, forward: boolean, distance?: number) => {
    const current = view.state.doc.lineAt(start.head);
    const lineDelta = Math.max(1, Math.round((distance ?? lineHeight) / lineHeight));
    const targetNumber = Math.min(
      view.state.doc.lines,
      Math.max(1, current.number + (forward ? lineDelta : -lineDelta)),
    );
    const target = view.state.doc.line(targetNumber);
    const documentColumn = Math.min(start.head - current.from, target.length);
    return EditorSelection.cursor(
      target.from + documentColumn,
      1,
      undefined,
      start.goalColumn ?? undefined,
    );
  });
  Object.defineProperty(view, "moveVertically", { value: moveVertically, configurable: true });
  return moveVertically;
}

export function mount(doc: string, policyEnabled = true): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        // The host enables this globally (§8.18.2); without it CM collapses
        // every secondary caret and multi-caret assertions are meaningless.
        EditorState.allowMultipleSelections.of(true),
        virtualSpaceOverflowField,
        virtualSpaceTypingHandler,
        virtualSpaceClickHandler,
        ...(policyEnabled ? [POLICY] : []),
      ],
    }),
  });
}
