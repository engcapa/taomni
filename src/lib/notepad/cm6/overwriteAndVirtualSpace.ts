import { Compartment, EditorSelection, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

export const setOverwriteModeEffect = StateEffect.define<boolean>();
export const setVirtualSpaceEffect = StateEffect.define<boolean>();

export const overwriteModeField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setOverwriteModeEffect)) return effect.value;
    }
    return value;
  },
});

export const virtualSpaceField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setVirtualSpaceEffect)) return effect.value;
    }
    return value;
  },
});

export function createOverwriteExtension(onToggle?: (insertMode: boolean) => void): Extension {
  const inputHandler = EditorView.inputHandler.of((view, from, to, text) => {
    const overwrite = view.state.field(overwriteModeField, false);
    if (!overwrite || view.state.readOnly) return false;
    if (from !== to || !text || text.includes("\n")) return false;
    const line = view.state.doc.lineAt(from);
    if (from >= line.to) return false;
    const deleteTo = Math.min(line.to, from + text.length);
    view.dispatch({
      changes: { from, to: deleteTo, insert: text },
      selection: EditorSelection.cursor(from + text.length),
      userEvent: "input.type",
    });
    return true;
  });

  const theme = EditorView.baseTheme({
    "&.np-overwrite .cm-cursor": {
      borderLeftWidth: "7px",
      opacity: "0.65",
    },
  });

  const insertKey = keymap.of([
    {
      key: "Insert",
      run(view) {
        const current = view.state.field(overwriteModeField, false);
        const next = !current;
        view.dispatch({ effects: setOverwriteModeEffect.of(next) });
        onToggle?.(!next);
        return true;
      },
    },
  ]);

  const classAttr = EditorView.editorAttributes.of((view) =>
    view.state.field(overwriteModeField, false) ? { class: "np-overwrite" } : null,
  );

  return [overwriteModeField, inputHandler, theme, insertKey, classAttr];
}

export const virtualSpaceCompartment = new Compartment();

/**
 * Virtual space support: allows Tab/Arrow navigation or padding past line ends
 * when virtualSpace mode is active, and handles virtual column padding before insert.
 */
export function createVirtualSpaceExtension(enabled = false): Extension {
  const padKey = keymap.of([
    {
      key: "ArrowRight",
      run(view) {
        if (!view.state.field(virtualSpaceField, false) || view.state.readOnly) return false;
        const main = view.state.selection.main;
        if (!main.empty) return false;
        const line = view.state.doc.lineAt(main.head);
        if (main.head < line.to) return false;
        view.dispatch({
          changes: { from: main.head, to: main.head, insert: " " },
          selection: EditorSelection.cursor(main.head + 1),
        });
        return true;
      },
    },
  ]);

  return [virtualSpaceField.init(() => enabled), padKey];
}
