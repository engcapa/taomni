import { useCallback } from "react";
import { useLocale } from "../../lib/i18n";

export function useViewerLabels() {
  const { locale } = useLocale();
  return useCallback((zh: string, en: string) => locale === "zh-CN" ? zh : en, [locale]);
}
