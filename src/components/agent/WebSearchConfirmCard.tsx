import { Globe, X } from "lucide-react";
import { useT } from "../../lib/i18n";

export type WebSearchDecision = "allow" | "allow-session" | "deny";

interface WebSearchConfirmCardProps {
  query: string;
  provider: string;
  providerUrl?: string;
  onDecide: (decision: WebSearchDecision) => void;
}

export function WebSearchConfirmCard({ query, provider, providerUrl, onDecide }: WebSearchConfirmCardProps) {
  const t = useT();
  const providerLabel = providerUrl ? `${provider} @ ${providerUrl}` : provider;

  return (
    <div className="rounded-lg border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3 shadow-lg max-w-sm w-full">
      <div className="flex items-center gap-2 mb-2">
        <Globe className="w-4 h-4 text-[var(--taomni-accent)] shrink-0" />
        <span className="text-[12px] font-semibold flex-1">{t("agent.webSearchTitle")}</span>
        <button
          type="button"
          className="text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)]"
          onClick={() => onDecide("deny")}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="space-y-1 mb-3">
        <div className="text-[11px]">
          <span className="text-[var(--taomni-text-muted)]">{t("agent.webSearchQueryLabel")}</span>
          <span className="font-medium">"{query}"</span>
        </div>
        <div className="text-[11px]">
          <span className="text-[var(--taomni-text-muted)]">{t("agent.webSearchProviderLabel")}</span>
          <span>{providerLabel}</span>
        </div>
      </div>

      <div className="text-[10px] text-yellow-500 mb-3">
        {t("agent.webSearchPrivacyWarn")}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="taomni-btn h-7 px-3 text-[12px]"
          onClick={() => onDecide("allow")}
        >
          {t("agent.webSearchAllowOnce")}
        </button>
        <button
          type="button"
          className="taomni-btn h-7 px-3 text-[12px]"
          onClick={() => onDecide("allow-session")}
          title={t("agent.webSearchAllowSessionTitle")}
        >
          {t("agent.webSearchAllowSession")}
        </button>
        <button
          type="button"
          className="taomni-btn h-7 px-3 text-[12px] text-[var(--taomni-text-muted)]"
          onClick={() => onDecide("deny")}
        >
          {t("agent.webSearchDeny")}
        </button>
      </div>
    </div>
  );
}
