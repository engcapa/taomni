import { lazy, Suspense, type ReactNode } from "react";
import { useT } from "../../lib/i18n";
import type { MfaRendererInput } from "../../lib/mfa/rendererContract";
import { openSettingsSection } from "../../lib/settingsNavigation";
import { usePluginFrontendRegistry } from "../../lib/usePluginFrontendRegistry";
import { FLOATING_MFA_WIDTH } from "../../stores/app/layoutSlice";
import { useAppStore } from "../../stores/appStore";
import { PluginTabPane } from "./PluginTabPane";

const BundledMfa = __TAOMNI_BUNDLED_MFA_RENDERER__
  ? lazy(() => import("../../../src-tauri/plugins/mfa/renderer/MfaView"))
  : null;
const SLUG = "mfa";

export function MfaSessionPane({ tabId, active, unavailableActions, ...input }: MfaRendererInput & {
  tabId: string;
  active: boolean;
  unavailableActions?: ReactNode;
}) {
  const t = useT();
  const { records, pending, status } = usePluginFrontendRegistry();
  const record = records[SLUG];
  if (BundledMfa && status === "ready" && !pending.has(SLUG)
    && (!record || (record.lifecycle === "enabled" && !record.manifest?.entry.frontend))) {
    return <Suspense fallback={<p role="status">{t("plugins.loading")}</p>}><BundledMfa {...input} /></Suspense>;
  }

  return <PluginTabPane<MfaRendererInput> tab={{ id: tabId, plugin: { slug: SLUG, kind: input.view } }}
    active={active} componentProps={input} unavailableActions={unavailableActions}
    onOpenSettings={() => openSettingsSection("module-store")} />;
}

export function MfaFloatingPane({ onExpand }: { onExpand: () => void }) {
  const t = useT();
  const floating = useAppStore((state) => state.floatingMfa);
  const close = useAppStore((state) => state.closeFloatingMfa);
  if (!floating.open) return null;

  return <div data-testid="mfa-floating-entry" className="fixed rounded-lg bg-[var(--taomni-panel-bg)]"
    aria-label={t("platform.mfaTitle")} style={{ ...floating.position, width: FLOATING_MFA_WIDTH, zIndex: floating.pinned ? 960 : 950 }}>
    <MfaSessionPane tabId="mfa-floating" active view="floating" onExpand={onExpand} unavailableActions={
      <button type="button" className="taomni-btn px-3 py-1" onClick={close}>{t("platform.mfaClose")}</button>
    } />
  </div>;
}
