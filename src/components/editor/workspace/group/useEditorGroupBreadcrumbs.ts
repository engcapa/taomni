import { useEffect, type ReactNode } from "react";
import { useCodeWorkspaceStatusStore } from "../../../../stores/codeWorkspaceStatusStore";

export type EditorGroupBreadcrumbs = ReactNode | ((variant: "bar" | "statusbar") => ReactNode);

/** Placement and appearance share the same live portal owner. */
export function useEditorGroupBreadcrumbs({
  content, placement, visible, active, ownerId,
}: {
  content: EditorGroupBreadcrumbs;
  placement: "top" | "bottom" | "status-bar";
  visible: boolean;
  active: boolean;
  ownerId: string;
}) {
  const navigationHost = useCodeWorkspaceStatusStore((state) => state.navigationHost);
  const setOwner = useCodeWorkspaceStatusStore((state) => state.setNavigationPortalOwner);
  const statusBarNavigation = placement === "status-bar" && active && visible ? navigationHost : null;
  const breadcrumbs = typeof content === "function" ? content(statusBarNavigation ? "statusbar" : "bar") : content;
  const present = !!breadcrumbs;
  useEffect(() => {
    if (!statusBarNavigation || !present) return;
    setOwner(ownerId);
    return () => setOwner(null, ownerId);
  }, [ownerId, present, setOwner, statusBarNavigation]);
  return { breadcrumbs, statusBarNavigation };
}
