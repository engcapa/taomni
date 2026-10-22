import { type Completion } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { type LiveTemplateLanguage } from "../../../../lib/liveTemplatePreferences";
import { type LiveTemplateSourceOptions, type LiveTemplate } from "./types";
import { matchLiveTemplateAbbreviation, templatesFor } from "./matching";

export function providerOwnedPlainAbbreviations(
  language: LiveTemplateLanguage,
  options: LiveTemplateSourceOptions | undefined,
): ReadonlySet<string> | undefined {
  const owned = options?.providerOwnedAbbreviations?.(language);
  return owned && owned.size > 0 ? owned : undefined;
}

export function yieldsToProvider(
  template: LiveTemplate,
  owned: ReadonlySet<string> | undefined,
): boolean {
  return !!owned && !template.postfix && owned.has(template.abbreviation);
}

/**
 * True when the caret sits right after an exact plain abbreviation whose
 * template is provider-owned, so Tab must route to provider completion instead
 * of expanding the app template (or inserting indentation).
 */
export function providerOwnedExactAbbreviationAt(
  view: EditorView,
  language: LiveTemplateLanguage,
  options?: LiveTemplateSourceOptions,
): boolean {
  const owned = providerOwnedPlainAbbreviations(language, options);
  if (!owned) return false;
  const pos = view.state.selection.main.head;
  if (!view.state.selection.main.empty) return false;
  const plain = matchLiveTemplateAbbreviation(view.state.doc, pos, language);
  return !!plain?.exact && yieldsToProvider(plain.template, owned);
}

export function isProviderTemplateSnippet(option: Completion): boolean {
  if (option.isTemplateSnippet !== undefined) return option.isTemplateSnippet;
  if (option.rawKind !== undefined) return option.rawKind === 15;
  return option.type === "text";
}

/**
 * Abbreviations of provider snippet proposals. LSP CompletionItemKind.Snippet (15)
 * represents template snippets. Non-template text/references (kinds 1, 18) must
 * never claim an app template abbreviation.
 */
export function providerSnippetAbbreviations(
  options: readonly Completion[],
): Set<string> {
  const labels = new Set<string>();
  for (const option of options) {
    if (isProviderTemplateSnippet(option) && option.label) {
      labels.add(option.label);
    }
  }
  return labels;
}

/** Plain (non-postfix) abbreviations the app offers for a language. */
export function plainTemplateAbbreviations(language: LiveTemplateLanguage): Set<string> {
  return new Set(templatesFor(language, false).map((template) => template.abbreviation));
}
