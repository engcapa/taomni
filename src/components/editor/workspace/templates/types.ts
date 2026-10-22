import { type LiveTemplateLanguage } from "../../../../lib/liveTemplatePreferences";

export interface LiveTemplate {
  /** Typed abbreviation, e.g. `sout`. */
  abbreviation: string;
  /**
   * CodeMirror snippet body. Placeholders: `${name}` (linked by name),
   * `${}` empty tabstop. Newlines are indented to the caret column by CM.
   */
  body: string;
  /** Short description shown as the completion detail. */
  description: string;
  languages: readonly LiveTemplateLanguage[];
  /**
   * When true, matches `expr.abbr` (IDEA postfix completion) and substitutes
   * `$EXPR$` in the body with the left-hand expression text.
   */
  postfix?: boolean;
}

/**
 * Provider-owned plain abbreviations for the active language. When the
 * language provider already offers an exact template for an abbreviation
 * (jdtls ships the Eclipse Java editor templates as snippet proposals), the
 * provider's proposal wins and the app's live template only fills the gaps the
 * provider does not cover. Postfix forms stay app-owned: the provider has no
 * postfix completion.
 */
export interface LiveTemplateSourceOptions {
  providerOwnedAbbreviations?: (
    language: LiveTemplateLanguage,
  ) => ReadonlySet<string> | undefined;
}

// ── Matching ─────────────────────────────────────────────────────────────

export interface LiveTemplateMatch {
  from: number;
  to: number;
  template: LiveTemplate;
  /** Present for postfix matches — raw left-hand expression. */
  expr?: string;
  /** Typed abbreviation prefix used for ranking. */
  typed: string;
  exact: boolean;
}
