import type { Text } from "@codemirror/state";
import { type LiveTemplateLanguage, type LiveTemplatePreferences } from "../../../../lib/liveTemplatePreferences";
import { preferencesCache } from "./preferences";
import { type LiveTemplate, type LiveTemplateMatch } from "./types";
import { LIVE_TEMPLATES, builtinTemplateKey, customTemplateToLiveTemplate } from "./catalog/index";
import { languageMatches } from "./language";

/**
 * Built-ins + enabled custom templates for a language, respecting Settings.
 */
export function templatesFor(
  language: LiveTemplateLanguage,
  postfix: boolean,
  preferences: LiveTemplatePreferences = preferencesCache,
): LiveTemplate[] {
  if (!preferences.enabled) return [];
  if (postfix && !preferences.postfixEnabled) return [];

  const disabled = new Set(preferences.disabledBuiltinKeys);
  const builtins = LIVE_TEMPLATES.filter((template) => (
    languageMatches(template, language)
    && !!template.postfix === postfix
    && !disabled.has(builtinTemplateKey(template))
  ));

  const customs = preferences.customTemplates
    .filter((custom) => custom.enabled && !!custom.postfix === postfix)
    .map(customTemplateToLiveTemplate)
    .filter((template) => languageMatches(template, language));

  return [...builtins, ...customs];
}

/** All built-ins for Settings UI, annotated with enable state. */
export function listBuiltinTemplatesForSettings(
  preferences: LiveTemplatePreferences = preferencesCache,
): Array<LiveTemplate & { key: string; enabled: boolean; }> {
  return LIVE_TEMPLATES.map((template) => {
    const key = builtinTemplateKey(template);
    return {
      ...template,
      key,
      enabled: !preferences.disabledBuiltinKeys.includes(key),
    };
  });
}

/**
 * Match a simple live-template abbreviation at `pos` (identifier before caret).
 * Prefers the longest exact abbreviation; otherwise the longest prefix match.
 */
export function matchLiveTemplateAbbreviation(
  doc: Text,
  pos: number,
  language: LiveTemplateLanguage,
): LiveTemplateMatch | null {
  const line = doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  const word = before.match(/[A-Za-z_$@][\w$]*$/);
  if (!word) return null;
  const typed = word[0];
  // Do not steal member access completions (`obj.s…`).
  const charBeforeWord = before.slice(0, -typed.length).slice(-1);
  if (charBeforeWord === ".") return null;

  const from = pos - typed.length;
  const candidates = templatesFor(language, false)
    .filter((template) => template.abbreviation.startsWith(typed) || typed.startsWith(template.abbreviation))
    // Only suggest when the user is typing the abbreviation, not after they
    // already overshot a short one without expanding (e.g. typed "soutx").
    .filter((template) => typed.length <= template.abbreviation.length
      && template.abbreviation.startsWith(typed));

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    const aExact = a.abbreviation === typed ? 1 : 0;
    const bExact = b.abbreviation === typed ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    // Prefer longer abbreviations so `soutv` wins over `sout` when typing "soutv".
    if (a.abbreviation.length !== b.abbreviation.length) {
      return b.abbreviation.length - a.abbreviation.length;
    }
    return a.abbreviation.localeCompare(b.abbreviation);
  });

  // When multiple abbreviations share a prefix (sout / soutv / soutm), return
  // null from the single-expand helper path unless exact — list shows all.
  const best = candidates[0];
  return {
    from,
    to: pos,
    template: best,
    typed,
    exact: best.abbreviation === typed,
  };
}

/**
 * Match IDEA postfix form `expr.abbr` where `abbr` is a known postfix template.
 * Expression is a simple identifier or member chain (no spaces/operators).
 */
export function matchPostfixTemplate(
  doc: Text,
  pos: number,
  language: LiveTemplateLanguage,
): LiveTemplateMatch | null {
  const line = doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  const match = before.match(/([A-Za-z_$@][\w$]*(?:\.[A-Za-z_$@][\w$]*)*)\.([A-Za-z_][\w]*)$/);
  if (!match || match.index == null) return null;
  const expr = match[1];
  const typed = match[2];
  const candidates = templatesFor(language, true)
    .filter((template) => template.abbreviation.startsWith(typed));
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const aExact = a.abbreviation === typed ? 1 : 0;
    const bExact = b.abbreviation === typed ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    return b.abbreviation.length - a.abbreviation.length;
  });
  const best = candidates[0];
  return {
    from: line.from + match.index,
    to: pos,
    template: best,
    expr,
    typed,
    exact: best.abbreviation === typed,
  };
}

export function listLiveTemplateCompletions(
  doc: Text,
  pos: number,
  language: LiveTemplateLanguage,
): { from: number; to: number; matches: LiveTemplateMatch[]; } | null {
  const line = doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);

  // Postfix first when the caret sits after `.abbr`.
  const postfixMatch = before.match(/([A-Za-z_$@][\w$]*(?:\.[A-Za-z_$@][\w$]*)*)\.([A-Za-z_][\w]*)$/);
  if (postfixMatch && postfixMatch.index != null) {
    const expr = postfixMatch[1];
    const typed = postfixMatch[2];
    const matches = templatesFor(language, true)
      .filter((template) => template.abbreviation.startsWith(typed))
      .map((template): LiveTemplateMatch => ({
        from: line.from + postfixMatch.index!,
        to: pos,
        template,
        expr,
        typed,
        exact: template.abbreviation === typed,
      }));
    if (matches.length) {
      return { from: line.from + postfixMatch.index, to: pos, matches };
    }
  }

  const word = before.match(/[A-Za-z_$@][\w$]*$/);
  if (!word) return null;
  const typed = word[0];
  const charBeforeWord = before.slice(0, -typed.length).slice(-1);
  if (charBeforeWord === ".") return null;
  const from = pos - typed.length;
  const matches = templatesFor(language, false)
    .filter((template) => template.abbreviation.startsWith(typed))
    .map((template): LiveTemplateMatch => ({
      from,
      to: pos,
      template,
      typed,
      exact: template.abbreviation === typed,
    }));
  if (!matches.length) return null;
  return { from, to: pos, matches };
}
