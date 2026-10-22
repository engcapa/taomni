import { EditorView } from "@codemirror/view";
import { type CompletionAcceptIntent } from "./types";

export const completionAcceptIntent = new WeakMap<EditorView, CompletionAcceptIntent>();


/** The key handler owns this intent only for CodeMirror's synchronous apply call. */
export function withCompletionAcceptIntent<T>(
  view: EditorView,
  intent: CompletionAcceptIntent,
  action: () => T,
): T {
  completionAcceptIntent.set(view, intent);
  try {
    return action();
  } finally {
    completionAcceptIntent.delete(view);
  }
}
