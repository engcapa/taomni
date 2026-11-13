import { useCallback } from "react";
import { useLocale } from "../../lib/i18n";

/** Feature-local bilingual copy keeps the prototype's Chinese wording intact. */
export function useExplorerLabels() {
  const { locale } = useLocale();
  return useCallback((zh: string, en: string) => locale === "zh-CN" ? zh : en, [locale]);
}
