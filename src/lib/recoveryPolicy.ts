import type { TabKind } from "../types";
import { t } from "./i18n";
import { recoveryZh } from "./i18n/locales/recovery";

/** Canonical tab roster. Exported descriptions also serve existing Chinese-language callers. */
export const RECOVERY_LIMITATIONS: Record<TabKind, string> = recoveryZh.policy;

export function recoveryLimitation(kind: string): string {
  return Object.hasOwn(RECOVERY_LIMITATIONS, kind) ? t(`recovery.policy.${kind}`) : t("recovery.unknownKind");
}
