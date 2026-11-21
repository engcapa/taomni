import type { NotepadCommandDefinition } from "./types";

/**
 * Locale-aware command label.
 *
 * Chinese (any `zh*` locale) uses the catalog's `zhLabel`; every command that
 * ships in the catalog defines one. All other locales fall back to the English
 * `defaultLabel`.
 */
export function commandLabel(def: NotepadCommandDefinition, locale: string): string {
  if (locale.toLowerCase().startsWith("zh") && def.zhLabel) {
    return def.zhLabel;
  }
  return def.defaultLabel;
}
