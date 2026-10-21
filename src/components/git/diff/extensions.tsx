import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { codeViewExtensions } from "../../../lib/codeViewTheme";


export const diffTheme = EditorView.theme({
  "&": { backgroundColor: "var(--taomni-code-bg)", color: "var(--taomni-code-text)", height: "100%" },
  ".cm-content": { caretColor: "transparent" },
  ".cm-cursor": { display: "none" },
});


export const diffThemeEditable = EditorView.theme({
  "&": { backgroundColor: "var(--taomni-code-bg)", color: "var(--taomni-code-text)", height: "100%" },
  ".cm-content": { caretColor: "var(--taomni-code-text)" },
});


export function baseExtensions(language: Extension | null, editable = false): Extension[] {
  const ext: Extension[] = [
    lineNumbers(),
    EditorView.editable.of(editable),
    EditorState.readOnly.of(!editable),
    ...codeViewExtensions(),
    editable ? diffThemeEditable : diffTheme,
  ];
  if (language) ext.push(language);
  return ext;
}
