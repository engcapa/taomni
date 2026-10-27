import { alertAppDialog } from "../../lib/appDialogs";
import { t } from "../../lib/i18n";

export function showAgentsComingSoon() {
  void alertAppDialog({ title: "Agents / Crew", message: t("platform.agentsComingSoon") });
}
