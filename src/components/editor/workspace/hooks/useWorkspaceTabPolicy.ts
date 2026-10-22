import { useCallback, useRef, useState } from "react";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import { type TabPolicyLifecycleReceiptView } from "../controller/model";
import { DEFAULT_WORKSPACE_TAB_POLICY_V3, type WorkspaceTabPolicyV3 } from "../workspaceTabPolicy";


export interface UseWorkspaceTabPolicyContext {
  workspaceInstanceId: string;
}

export function useWorkspaceTabPolicy(context: UseWorkspaceTabPolicyContext) {
  const { workspaceInstanceId } = context;
  // §8.19.6 per-workspace tab policy: restored from the layout snapshot
  // (migrated/repaired on read) and consumed by open-time limit enforcement.
  // Editing UI is deferred — restored values already govern eviction.
  const [tabPolicy, setTabPolicy] = useState<WorkspaceTabPolicyV3>(() => ({ ...DEFAULT_WORKSPACE_TAB_POLICY_V3 }));
  const tabPolicyRef = useRef(tabPolicy);
  tabPolicyRef.current = tabPolicy;
  const tabPolicyTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [tabPolicyRevision, setTabPolicyRevision] = useState(0);
  // §8.26.3 AA2: Monotonic layout revision and base revision for tab policy transactions (§ED-TABS-001)
  const layoutRevision = useCodeWorkspaceStore(
    (state) => state.byInstanceId[workspaceInstanceId]?.layoutRevision ?? 0,
  );
  const [baseLayoutRevision, setBaseLayoutRevision] = useState(0);

  const openTabPolicySettings = useCallback(() => {
    const trigger = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    // ED-PARITY-010: an opener inside the transient ⋮ menu disappears with it;
    // return focus to the ⋮ anchor instead.
    tabPolicyTriggerRef.current = trigger?.closest('[data-testid="code-workspace-toolbar-more-menu"]')
      ? document.querySelector<HTMLButtonElement>('[data-testid="code-workspace-toolbar-more"]')
      : trigger;
    setBaseLayoutRevision(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).layoutRevision);
    setTabPolicySettingsOpen(true);
  }, [workspaceInstanceId]);

  const closeTabPolicySettings = useCallback(() => {
    setTabPolicySettingsOpen(false);
    requestAnimationFrame(() => tabPolicyTriggerRef.current?.focus());
  }, []);
  const [tabPolicySettingsOpen, setTabPolicySettingsOpen] = useState(false);
  const [tabPolicyReceipt, setTabPolicyReceipt] = useState<TabPolicyLifecycleReceiptView | null>(null);
  return { setTabPolicy, setTabPolicyReceipt, tabPolicyRef, tabPolicyRevision, openTabPolicySettings, tabPolicy, baseLayoutRevision, setTabPolicyRevision, layoutRevision, tabPolicyReceipt, tabPolicySettingsOpen, closeTabPolicySettings };
}
