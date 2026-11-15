import { ChevronDown, MoreHorizontal, Search, SlidersHorizontal } from "lucide-react";
import type { ChatProfile, TaoChatState, TaoMode } from "./ports";

export function TopBar({
  state,
  profile,
  onMode,
  onSearch,
  onMore,
  slots,
}: {
  state: TaoChatState;
  profile: ChatProfile;
  onMode: (mode: TaoMode) => void;
  onSearch: () => void;
  onMore: () => void;
  slots?: React.ReactNode;
}) {
  const runtime = state.activeThreadId ? state.runtime[state.activeThreadId] : undefined;
  const budget = runtime?.budget;
  const warning = budget?.warning;
  return (
    <header className="tao-home-topbar" data-testid="tao-home-topbar">
      <div className="tao-home-topbar-leading">{slots}</div>
      <div className="tao-home-mode-segment" role="tablist" aria-label="Tao 模式">
        {profile.modes.map((mode) => (
          <button
            key={mode.id}
            type="button"
            role="tab"
            aria-selected={state.mode === mode.id}
            data-testid={`tao-home-mode-${mode.id}`}
            className={state.mode === mode.id ? "is-active" : ""}
            title={mode.description}
            onClick={() => onMode(mode.id)}
          >
            {mode.label}
          </button>
        ))}
      </div>
      <div className="tao-home-topbar-actions">
        {budget && budget.usedTokens > 0 ? (
          <button type="button" className={`tao-home-usage-pill warning-${warning ?? 0}`} data-testid="tao-home-usage-pill" title="用量与预算">
            {formatTokens(budget.usedTokens)} / {formatTokens(budget.limitTokens)}
          </button>
        ) : null}
        <button type="button" className="tao-home-icon-button" data-testid="tao-home-search" aria-label="搜索 Taomni 本地资料" onClick={onSearch}><Search size={15} /><kbd>⌘K</kbd></button>
        <button type="button" className="tao-home-icon-button" data-testid="tao-home-more" aria-label="更多" onClick={onMore}><MoreHorizontal size={16} /></button>
        <button type="button" className="tao-home-icon-button" aria-label="界面设置" onClick={onMore}><SlidersHorizontal size={15} /><ChevronDown size={12} /></button>
      </div>
    </header>
  );
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}
