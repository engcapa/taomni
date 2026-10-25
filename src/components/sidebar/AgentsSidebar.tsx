import { Bot } from "lucide-react";
import { useT } from "../../lib/i18n";
import { showAgentsComingSoon } from "../agents/comingSoon";

export function AgentsSidebar() {
  const t = useT();
  return (
    <div data-testid="agents-sidebar-panel" className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <button type="button" className="taomni-btn inline-flex items-center gap-2 px-2 py-1" onClick={showAgentsComingSoon}>
        <Bot className="h-4 w-4" />Agents / Crew
      </button>
      <p className="text-[11.5px] text-[var(--taomni-text-muted)]">{t("platform.agentsComingSoon")}</p>
    </div>
  );
}
