import { create } from "zustand";
import {
  readStripeSettings,
  writeStripeSettings,
  type ToolWindowStripeSettings,
} from "./toolWindowLayout";

/**
 * IDEA UISettings SHOW_TOOL_WINDOW_NAMES and stripe widths, shared by every
 * tool window bar: all Code Workspace instances and the merged sidebar rail
 * of terminal tabs (ED-PARITY-027) read and write the same settings.
 */
interface ToolWindowStripeStoreState {
  settings: ToolWindowStripeSettings;
  setWidth: (side: "left" | "right", width: number) => void;
  toggleShowNames: () => void;
}

export const useToolWindowStripeStore = create<ToolWindowStripeStoreState>((set) => ({
  settings: readStripeSettings(),
  setWidth: (side, width) => set((state) => {
    const settings = side === "left"
      ? { ...state.settings, leftWidth: width }
      : { ...state.settings, rightWidth: width };
    writeStripeSettings(settings);
    return { settings };
  }),
  toggleShowNames: () => set((state) => {
    const settings = { ...state.settings, showNames: !state.settings.showNames };
    writeStripeSettings(settings);
    return { settings };
  }),
}));
