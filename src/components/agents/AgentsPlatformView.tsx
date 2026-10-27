import { Bot } from "lucide-react";
import { useT } from "../../lib/i18n";
import { showAgentsComingSoon } from "./comingSoon";

/** Crew orchestration is deferred; no simulated worktree execution is shown. */
export function AgentsPlatformView() {
  const t = useT();
  return (
    <div data-testid="agents-platform-view" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6">
      <Bot className="h-8 w-8 text-[var(--taomni-text-muted)]" />
      <div className="text-[13px] font-semibold">Agents / Crew</div>
      <p data-testid="agents-coming-soon" className="text-[12px] text-[var(--taomni-text-muted)]">{t("platform.agentsComingSoon")}</p>
      <button type="button" data-testid="agents-dispatch-open" className="taomni-btn px-3 py-1" onClick={showAgentsComingSoon}>{t("platform.agents")}</button>
    </div>
  );
}
