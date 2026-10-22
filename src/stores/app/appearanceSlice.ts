import { type StateCreator } from "zustand";
import { type AppState } from "./types";
import { readUiFontFamily, readUiFontSize, readVaultUnlockMode, writeUiFontFamily, clampUiFontSize, writeUiFontSize, writeVaultUnlockMode } from "./preferences";

export const createAppearanceSlice: StateCreator<AppState, [], [], Pick<AppState, "uiFontFamily" | "uiFontSize" | "vaultUnlockMode" | "setUiFontFamily" | "setUiFontSize" | "setVaultUnlockMode">> = (set) => ({
  uiFontFamily: readUiFontFamily(),
  uiFontSize: readUiFontSize(),
  vaultUnlockMode: readVaultUnlockMode(),

  setUiFontFamily: (font) =>
    set(() => {
      writeUiFontFamily(font);
      return { uiFontFamily: font };
    }),

  setUiFontSize: (size) =>
    set(() => {
      const next = clampUiFontSize(size);
      writeUiFontSize(next);
      return { uiFontSize: next };
    }),

  setVaultUnlockMode: (mode) =>
    set(() => {
      writeVaultUnlockMode(mode);
      return { vaultUnlockMode: mode };
    })
});
