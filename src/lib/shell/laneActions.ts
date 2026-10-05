import { useAppStore } from "../../stores/appStore";
import { useShellLayoutStore } from "../../stores/shellLayoutStore";
import { tabLane } from "./tabPresentation";
import type { TabLane } from "./types";

/** One routing contract shared by the dock and global Actions. */
export function activateShellLane(lane: TabLane): void {
  const app = useAppStore.getState(), shell = useShellLayoutStore.getState();
  const target = shell.mru.map((id) => app.tabs.find((tab) => tab.id === id))
    .find((tab) => tab && tabLane(tab, shell.laneOverrides[tab.id]) === lane)
    ?? app.tabs.find((tab) => tabLane(tab, shell.laneOverrides[tab.id]) === lane);
  if (target) { app.setActiveTab(target.id); shell.visitTab(target.id); }
  else shell.selectLane(lane);
}
