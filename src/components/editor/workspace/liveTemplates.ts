export type { LiveTemplateLanguage } from "../../../lib/liveTemplatePreferences";

export { type LiveTemplate, type LiveTemplateSourceOptions, type LiveTemplateMatch } from "./templates/types";

export { providerOwnedExactAbbreviationAt, isProviderTemplateSnippet, providerSnippetAbbreviations, plainTemplateAbbreviations } from "./templates/provider";

export { liveTemplateLanguageForPath } from "./templates/language";

export { LIVE_TEMPLATES, builtinTemplateKey, customTemplateToLiveTemplate } from "./templates/catalog/index";

export { getLiveTemplatePreferencesCache, refreshLiveTemplatePreferencesCache } from "./templates/preferences";

export { templatesFor, listBuiltinTemplatesForSettings, matchLiveTemplateAbbreviation, matchPostfixTemplate, listLiveTemplateCompletions } from "./templates/matching";

export { materializeTemplateBody, applyLiveTemplate, expandLiveTemplateAt } from "./templates/expansion";

export { LIVE_TEMPLATE_EXACT_BOOST, LIVE_TEMPLATE_PREFIX_BOOST, LIVE_TEMPLATE_POSTFIX_BOOST, createLiveTemplateCompletionSource } from "./templates/completion";
