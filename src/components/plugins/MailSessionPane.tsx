import { lazy, Suspense } from "react";
import { useT } from "../../lib/i18n";
import type { MailRendererInput, MailRendererProps } from "../../lib/mail/rendererContract";
import { openSettingsSection } from "../../lib/settingsNavigation";
import { usePluginFrontendRegistry } from "../../lib/usePluginFrontendRegistry";
import { PluginTabPane } from "./PluginTabPane";

const LegacyMail = __TAOMNI_BUNDLED_MAIL_RENDERER__
  ? lazy(() => import("../../../src-tauri/plugins/mail/renderer/MailView"))
  : null;
const SLUG = "mail";

export default function MailSessionPane({ tabId, active, ...input }: MailRendererProps) {
  const t = useT();
  const state = usePluginFrontendRegistry();
  const record = state.records[SLUG];
  if (LegacyMail && state.status === "ready" && !state.pending.has(SLUG)
    && (record?.lifecycle !== "uninstalled" && !record?.manifest?.entry.frontend)) {
    // Dev and QA can retain the baseline UI for profiles with no frontend.
    return <Suspense fallback={<p role="status">{t("plugins.loading")}</p>}>
      <LegacyMail tabId={tabId} active={active} {...input} />
    </Suspense>;
  }
  return <PluginTabPane<MailRendererInput> tab={{ id: tabId, plugin: { slug: SLUG, kind: input.view } }}
    active={active} componentProps={input} onOpenSettings={() => openSettingsSection("module-store")} />;
}
