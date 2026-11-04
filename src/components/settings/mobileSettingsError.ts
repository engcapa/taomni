import type { TranslateFn } from "../../lib/i18n";

/** Keep diagnostic codes intact, but explain known failures in the active locale. */
export function mobileSettingsError(error: string, t: TranslateFn): string {
  const code = error.replace(/^Error:\s*/, "");
  const key = `mobileSettings.errors.${code}`;
  const translated = t(key);
  return translated === key ? t("mobileSettings.operationFailed", { detail: error }) : `${translated} (${code})`;
}
