import { useAppStore } from "../../stores/appStore";

/**
 * Toggle the left navigator from every shell entry point (Ctrl/Cmd+B, the
 * View menu, the title-bar button).
 *
 * Explorer is a rail-only surface after U6: it has no expanded sidebar content,
 * so the toggle must be a no-op there instead of revealing an empty panel.
 */
export function toggleSidebarForActiveMode(): void {
  const state = useAppStore.getState();
  if (state.activeSideTab === "explorer") return;
  state.toggleSidebar();
}
