import { type CustomLiveTemplate } from "../../../../../lib/liveTemplatePreferences";
import { type LiveTemplate } from "../types";
import { JAVA_TEMPLATES } from "./java";
import { KOTLIN_TEMPLATES } from "./jvm";
import { JS_TS_TEMPLATES } from "./javascript";
import { PYTHON_TEMPLATES } from "./python";
import { RUST_TEMPLATES, GO_TEMPLATES } from "./systems";
import { CSHARP_TEMPLATES, PHP_TEMPLATES } from "./web";

/** All built-in templates. Language filtering is done at match time. */
export const LIVE_TEMPLATES: readonly LiveTemplate[] = [
  ...JAVA_TEMPLATES,
  ...KOTLIN_TEMPLATES,
  ...JS_TS_TEMPLATES,
  ...PYTHON_TEMPLATES,
  ...RUST_TEMPLATES,
  ...GO_TEMPLATES,
  ...CSHARP_TEMPLATES,
  ...PHP_TEMPLATES,
];

/**
 * Stable key for a built-in template (used by Settings to enable/disable).
 * Custom templates use their own `id` field instead.
 */
export function builtinTemplateKey(template: LiveTemplate): string {
  const langs = [...template.languages].sort().join(",");
  return `${langs}|${template.postfix ? "p" : "l"}|${template.abbreviation}`;
}

export function customTemplateToLiveTemplate(custom: CustomLiveTemplate): LiveTemplate {
  return {
    abbreviation: custom.abbreviation,
    body: custom.body,
    description: custom.description || "Custom template",
    languages: custom.languages,
    postfix: custom.postfix || undefined,
  };
}
