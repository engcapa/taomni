/**
 * Region marker grammar per language (§8.17.6 step 3). Markers are only
 * recognized behind the language's OWN comment token — a `#region` inside a
 * Python string or a `// region` in CSS never folds. Unknown languages yield
 * no region folding at all instead of scanning arbitrary text.
 */
export interface RegionCommentGrammar {
  /** Regex source matching the comment opener (without trailing space). */
  lineToken: RegExp;
  /** Block-comment opener when the language folds regions inside blocks. */
  block?: { open: RegExp; close: RegExp; };
}

export type RegionFoldingProvenance =
  | "explicit-comment"
  | "language-syntax"
  | "indent-fallback";
