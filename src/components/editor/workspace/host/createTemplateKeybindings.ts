import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { acceptCompletion } from "@codemirror/autocomplete";
import { expandLiveTemplateAt, liveTemplateLanguageForPath } from "../liveTemplates";
import { activeLspSnippetChoices, advanceLspSnippetTabstop, cycleLspSnippetChoice, retreatLspSnippetTabstop, withCompletionAcceptIntent } from "../lspCompletion";


export interface CreateTemplateKeybindingsContext {
  pathRef: import("react").RefObject<string>;
  getValidActiveProviderCandidate: (view: EditorView, language: import("../liveTemplates").LiveTemplateLanguage) => { completion: import("@codemirror/autocomplete").Completion; from: number; to: number; } | null;
  liveTemplateSourceOptions: import("../liveTemplates").LiveTemplateSourceOptions;
}

export function createTemplateKeybindings(context: CreateTemplateKeybindingsContext) {
  const { pathRef, getValidActiveProviderCandidate, liveTemplateSourceOptions } = context;
  return Prec.high(keymap.of([
    {
      key: "Tab",
      run: (view) => {
        // ED-AUDIT-011: Tab during IME composition selects the candidate.
        if (view.composing || view.state.readOnly) return false;
        if (withCompletionAcceptIntent(view, "replace", () => acceptCompletion(view))) return true;
        const language = liveTemplateLanguageForPath(pathRef.current);
        const providerCandidate = getValidActiveProviderCandidate(view, language);
        if (providerCandidate) {
          const { completion, from, to } = providerCandidate;
          if (typeof completion.apply === "function") {
            const apply = completion.apply;
            withCompletionAcceptIntent(view, "replace", () => apply(view, completion, from, to));
          } else if (typeof completion.apply === "string") {
            view.dispatch({
              changes: { from, to, insert: completion.apply },
              selection: { anchor: from + completion.apply.length },
              userEvent: "input.complete",
            });
          } else {
            view.dispatch({
              changes: { from, to, insert: completion.label },
              selection: { anchor: from + completion.label.length },
              userEvent: "input.complete",
            });
          }
          return true;
        }
        if (expandLiveTemplateAt(view, language, liveTemplateSourceOptions)) return true;
        if (activeLspSnippetChoices(view)) return cycleLspSnippetChoice(view);
        return advanceLspSnippetTabstop(view);
      },
    },
    {
      key: "Shift-Tab",
      run: (view) => {
        // ED-AUDIT-011: Shift-Tab during composition belongs to the IME.
        if (view.composing || view.state.readOnly) return false;
        return retreatLspSnippetTabstop(view);
      },
    },
  ]));
}
