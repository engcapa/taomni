import { Globe, X } from "lucide-react";

export type WebSearchDecision = "allow" | "allow-session" | "deny";

interface WebSearchConfirmCardProps {
  query: string;
  provider: string;
  providerUrl?: string;
  onDecide: (decision: WebSearchDecision) => void;
}

export function WebSearchConfirmCard({ query, provider, providerUrl, onDecide }: WebSearchConfirmCardProps) {
  const providerLabel = providerUrl ? `${provider} @ ${providerUrl}` : provider;

  return (
    <div className="rounded-lg border border-[var(--moba-divider)] bg-[var(--moba-panel-bg)] p-3 shadow-lg max-w-sm w-full">
      <div className="flex items-center gap-2 mb-2">
        <Globe className="w-4 h-4 text-[var(--moba-accent)] shrink-0" />
        <span className="text-[12px] font-semibold flex-1">Agent 想搜索网络</span>
        <button
          type="button"
          className="text-[var(--moba-text-muted)] hover:text-[var(--moba-text)]"
          onClick={() => onDecide("deny")}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="space-y-1 mb-3">
        <div className="text-[11px]">
          <span className="text-[var(--moba-text-muted)]">🔍 搜索关键词：</span>
          <span className="font-medium">"{query}"</span>
        </div>
        <div className="text-[11px]">
          <span className="text-[var(--moba-text-muted)]">📡 提供方：</span>
          <span>{providerLabel}</span>
        </div>
      </div>

      <div className="text-[10px] text-yellow-500 mb-3">
        ⚠ 这条搜索词会发送到第三方服务，可能被记录
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="moba-btn h-7 px-3 text-[12px]"
          onClick={() => onDecide("allow")}
        >
          允许一次
        </button>
        <button
          type="button"
          className="moba-btn h-7 px-3 text-[12px]"
          onClick={() => onDecide("allow-session")}
          title="本会话内不再询问"
        >
          本会话允许
        </button>
        <button
          type="button"
          className="moba-btn h-7 px-3 text-[12px] text-[var(--moba-text-muted)]"
          onClick={() => onDecide("deny")}
        >
          拒绝
        </button>
      </div>
    </div>
  );
}
