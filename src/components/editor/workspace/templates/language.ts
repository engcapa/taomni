import { type LiveTemplateLanguage } from "../../../../lib/liveTemplatePreferences";
import { type LiveTemplate } from "./types";

export function liveTemplateLanguageForPath(path: string | null | undefined): LiveTemplateLanguage {
  const name = (path ?? "").toLowerCase();
  const base = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : base;
  switch (ext) {
    case "java":
      return "java";
    case "kt":
    case "kts":
      return "kotlin";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "typescript";
    case "py":
    case "pyi":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "cs":
      return "csharp";
    case "php":
      return "php";
    default:
      return "generic";
  }
}

export function languageMatches(template: LiveTemplate, language: LiveTemplateLanguage): boolean {
  return template.languages.includes(language)
    || template.languages.includes("generic");
}
