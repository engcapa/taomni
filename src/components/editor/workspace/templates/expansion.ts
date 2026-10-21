import { snippet, type Completion } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { type LiveTemplateLanguage } from "../../../../lib/liveTemplatePreferences";
import { type LiveTemplate, type LiveTemplateMatch, type LiveTemplateSourceOptions } from "./types";
import { matchPostfixTemplate, matchLiveTemplateAbbreviation } from "./matching";
import { providerOwnedPlainAbbreviations, yieldsToProvider } from "./provider";

/** Replace `$EXPR$` / `$EXPRTYPE$` placeholders for postfix expansion. */
export function materializeTemplateBody(template: LiveTemplate, expr?: string): string {
  let body = template.body;
  if (expr != null) {
    // Escape `$` in expression so CM snippet parser does not treat them as fields.
    const safeExpr = expr.replace(/\$/g, "\\$");
    body = body.replaceAll("$EXPR$", safeExpr);
    // Placeholder type for cast — leave as a tabstop when unknown.
    body = body.replaceAll("$EXPRTYPE$", "${Type}");
  }
  return body;
}

export function applyLiveTemplate(
  view: EditorView,
  match: LiveTemplateMatch,
): void {
  if (view.state.readOnly) return;
  const body = materializeTemplateBody(match.template, match.expr);
  const completion: Completion = {
    label: match.template.abbreviation,
    type: "keyword",
  };
  snippet(body)(view, completion, match.from, match.to);
}

/**
 * Expand an exact live/postfix template under the caret.
 * Used by Tab when no completion popup is active (IDEA muscle memory).
 */
export function expandLiveTemplateAt(
  view: EditorView,
  language: LiveTemplateLanguage,
  options?: LiveTemplateSourceOptions,
): boolean {
  if (view.state.readOnly) return false;
  const pos = view.state.selection.main.head;
  if (!view.state.selection.main.empty) return false;

  const postfix = matchPostfixTemplate(view.state.doc, pos, language);
  if (postfix?.exact) {
    applyLiveTemplate(view, postfix);
    return true;
  }

  const owned = providerOwnedPlainAbbreviations(language, options);
  const plain = matchLiveTemplateAbbreviation(view.state.doc, pos, language);
  // When several templates share a prefix, only expand on exact abbreviation.
  if (plain?.exact) {
    // Disambiguate: if another longer template also starts with this exact
    // abbr as a prefix of a longer one the user might still be typing — but
    // exact means they typed the full abbr, so expand the exact one. A
    // provider-owned abbreviation stays with the provider instead.
    if (yieldsToProvider(plain.template, owned)) return false;
    applyLiveTemplate(view, plain);
    return true;
  }
  return false;
}
