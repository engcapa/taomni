import { useAppStore } from "../../stores/appStore";

/** Retain the established entry import while opening the real agent surface. */
export function showAgentsComingSoon() {
  useAppStore.getState().setActiveSideTab("agents");
}
