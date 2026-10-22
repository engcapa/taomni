import { type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import { isInsideStringOrComment } from "../syntaxContext";
import { type LiveTemplateMatch, type LiveTemplateSourceOptions } from "./types";
import { materializeTemplateBody, applyLiveTemplate } from "./expansion";
import { liveTemplateLanguageForPath } from "./language";
import { providerOwnedPlainAbbreviations, yieldsToProvider } from "./provider";
import { listLiveTemplateCompletions, templatesFor } from "./matching";

/** High boost so exact live templates beat ordinary LSP members. */
export const LIVE_TEMPLATE_EXACT_BOOST = 800;

export const LIVE_TEMPLATE_PREFIX_BOOST = 450;

export const LIVE_TEMPLATE_POSTFIX_BOOST = 700;

export function boostForMatch(match: LiveTemplateMatch): number {
  if (match.template.postfix) {
    return match.exact ? LIVE_TEMPLATE_POSTFIX_BOOST : LIVE_TEMPLATE_POSTFIX_BOOST - 50;
  }
  if (match.exact) return LIVE_TEMPLATE_EXACT_BOOST;
  // Longer remaining suffix ranks slightly lower (sout > so).
  const remaining = match.template.abbreviation.length - match.typed.length;
  return LIVE_TEMPLATE_PREFIX_BOOST - remaining;
}

export function matchToCompletion(match: LiveTemplateMatch): Completion {
  const preview = materializeTemplateBody(match.template, match.expr)
    .replace(/\n/g, "↵")
    .replace(/\t/g, "  ");
  const truncated = preview.length > 60 ? `${preview.slice(0, 57)}…` : preview;
  return {
    label: match.template.abbreviation,
    detail: match.template.description,
    // Keep abbreviation as the filter label; show expansion on the right via detail.
    info: () => {
      const dom = document.createElement("div");
      dom.className = "cm-lsp-hover";
      const title = document.createElement("div");
      title.style.fontWeight = "600";
      title.style.marginBottom = "4px";
      title.textContent = match.template.postfix
        ? `Postfix · ${match.template.abbreviation}`
        : `Live Template · ${match.template.abbreviation}`;
      const code = document.createElement("pre");
      code.style.margin = "0";
      code.style.fontFamily = "var(--taomni-code-font-family, monospace)";
      code.style.whiteSpace = "pre-wrap";
      code.textContent = materializeTemplateBody(match.template, match.expr ?? "${expr}");
      const desc = document.createElement("div");
      desc.style.marginTop = "6px";
      desc.style.opacity = "0.85";
      desc.textContent = match.template.description;
      dom.append(title, code, desc);
      return dom;
    },
    type: "keyword",
    boost: boostForMatch(match),
    // Encode a secondary sort so exact templates win within the same boost band.
    sortText: match.exact ? `0_${match.template.abbreviation}` : `1_${match.template.abbreviation}`,
    section: match.template.postfix ? "Postfix" : "Live Templates",
    apply: (view, _completion, from, to) => {
      applyLiveTemplate(view, { ...match, from, to });
    },
    // Expose preview for tests / optionClass consumers.
    displayLabel: match.template.postfix && match.expr
      ? `${match.expr}.${match.template.abbreviation} → ${truncated}`
      : undefined,
  };
}

/**
 * Completion source that offers IDEA-style live/postfix templates for the
 * language inferred from `path`. Synchronous and local — no LSP required.
 */
export function createLiveTemplateCompletionSource(
  pathOf: () => string | null | undefined,
  options?: LiveTemplateSourceOptions,
): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    // Never trigger live templates inside string literals or comments.
    if (isInsideStringOrComment(context.state, context.pos)) {
      return null;
    }

    const language = liveTemplateLanguageForPath(pathOf());
    const owned = providerOwnedPlainAbbreviations(language, options);
    // Require at least one character unless explicit (Ctrl+Space).
    const listed = listLiveTemplateCompletions(context.state.doc, context.pos, language);
    if (!listed) {
      if (!context.explicit) return null;
      if (context.matchBefore(/[\w$]+/)) return null;
      // Explicit invoke with no prefix: show a short starter set for the language.
      const starters = templatesFor(language, false)
        .filter((template) => !yieldsToProvider(template, owned))
        .slice(0, 30)
        .map((template): LiveTemplateMatch => ({
          from: context.pos,
          to: context.pos,
          template,
          typed: "",
          exact: false,
        }));
      if (!starters.length) return null;
      return {
        from: context.pos,
        options: starters.map(matchToCompletion),
        validFor: /^[\w$]*$/,
      };
    }

    // Provider-owned plain abbreviations yield to the provider's exact
    // templates; postfix matches stay app-owned.
    const matches = owned
      ? listed.matches.filter((match) => !yieldsToProvider(match.template, owned))
      : listed.matches;
    if (!matches.length) return null;

    // For non-explicit automatic typing:
    // Only offer templates if:
    // 1) Postfix template (e.g. list.for), OR
    // 2) Exact match (e.g. sout, psvm, if, fori), OR
    // 3) Typed prefix is at least 2 characters long (e.g. "so" -> sout).
    // Single-character prefix (like typing "s" or "i" or "t") MUST NOT hijack autocomplete popup!
    if (!context.explicit) {
      const isPostfix = matches[0]?.template.postfix ?? false;
      const hasExact = matches.some((m) => m.exact);
      const longestTyped = Math.max(...matches.map((m) => m.typed.length));
      if (!isPostfix && !hasExact && longestTyped < 2) {
        return null;
      }
    }

    return {
      from: listed.from,
      // For postfix, `from` spans the whole `expr.abbr`; CM filters against label
      // which is only the abbreviation, so disable client filter and re-query.
      options: matches
        .sort((a, b) => boostForMatch(b) - boostForMatch(a))
        .map(matchToCompletion),
      filter: !matches[0]?.template.postfix,
      validFor: matches[0]?.template.postfix ? undefined : /^[\w$]*$/,
    };
  };
}
