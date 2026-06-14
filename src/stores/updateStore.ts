import { create } from "zustand";
import {
  getUpdaterPlatform,
  checkForUpdate,
  downloadAndInstall,
  relaunchApp,
  type DownloadProgress,
} from "../lib/updateService";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "error"
  | "uptodate";

/** Validation state of the currently selected install package/arch. */
export type TargetStatus = "unknown" | "checking" | "ok" | "unavailable";

interface UpdateState {
  status: UpdateStatus;
  dialogOpen: boolean;
  /** True when the active check was user-triggered (About button) vs startup. */
  manual: boolean;

  availableVersion: string | null;
  currentVersion: string | null;
  notes: string;
  error: string | null;
  progress: DownloadProgress | null;

  // Package / architecture selection (see claudedocs/auto-update-plan.md).
  os: string | null;
  nativeTarget: string | null;
  recommendedTarget: string | null;
  candidates: string[];
  isRosetta: boolean;
  selectedTarget: string | null;
  targetStatus: TargetStatus;

  check: (opts?: { manual?: boolean }) => Promise<void>;
  setSelectedTarget: (target: string) => Promise<void>;
  startDownload: () => Promise<void>;
  restart: () => Promise<void>;
  openDialog: () => void;
  closeDialog: () => void;
  reset: () => void;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  status: "idle",
  dialogOpen: false,
  manual: false,
  availableVersion: null,
  currentVersion: null,
  notes: "",
  error: null,
  progress: null,
  os: null,
  nativeTarget: null,
  recommendedTarget: null,
  candidates: [],
  isRosetta: false,
  selectedTarget: null,
  targetStatus: "unknown",

  check: async (opts) => {
    const manual = opts?.manual ?? false;
    set({ status: "checking", manual, error: null });
    try {
      const platform = await getUpdaterPlatform();
      set({
        os: platform.os,
        nativeTarget: platform.nativeTarget,
        recommendedTarget: platform.recommendedTarget,
        candidates: platform.candidates,
        isRosetta: platform.isRosetta,
        selectedTarget: platform.recommendedTarget,
      });

      // For multi-candidate platforms (macOS Apple Silicon/Rosetta), use nativeTarget
      // to check specifically. For single-candidate platforms (Win/Linux), use undefined
      // to let Tauri auto-detect the installer-specific target (e.g. -deb, -appimage, -nsis, -msi).
      const checkTarget = platform.candidates.length > 1 ? platform.nativeTarget : undefined;
      const found = await checkForUpdate(checkTarget);
      if (!found) {
        set({
          status: "uptodate",
          availableVersion: null,
          currentVersion: null,
          notes: "",
          dialogOpen: manual,
          targetStatus: "unknown",
        });
        return;
      }

      const nativeIsRecommended = platform.recommendedTarget === platform.nativeTarget;
      set({
        status: "available",
        availableVersion: found.version,
        currentVersion: found.currentVersion,
        notes: found.notes,
        // Non-intrusive: startup/periodic checks only light up the title-bar
        // indicator. Only a manual check (About button) opens the window here;
        // otherwise the user opens it by clicking the indicator.
        dialogOpen: manual,
        targetStatus: nativeIsRecommended ? "ok" : "unknown",
      });
      // When we steer the user to a different arch (e.g. Rosetta → native
      // arm64), confirm that build actually exists for this version.
      if (!nativeIsRecommended) {
        await get().setSelectedTarget(platform.recommendedTarget);
      }
    } catch (e) {
      set({ status: "error", error: errMsg(e), dialogOpen: manual || get().dialogOpen });
    }
  },

  setSelectedTarget: async (target) => {
    set({ selectedTarget: target, targetStatus: "checking" });
    try {
      const found = await checkForUpdate(target);
      if (get().selectedTarget !== target) return; // superseded by a newer pick
      if (!found) {
        set({ targetStatus: "unavailable" });
      } else {
        set({
          targetStatus: "ok",
          availableVersion: found.version,
          currentVersion: found.currentVersion,
          notes: found.notes,
        });
      }
    } catch (e) {
      if (get().selectedTarget !== target) return;
      set({ targetStatus: "unavailable", error: errMsg(e) });
    }
  },

  startDownload: async () => {
    const { selectedTarget, candidates } = get();
    set({ status: "downloading", error: null, progress: { downloaded: 0, total: null, percent: 0 } });
    try {
      const downloadTarget = candidates.length > 1 ? (selectedTarget ?? undefined) : undefined;
      await downloadAndInstall(downloadTarget, (p) => set({ progress: p }));
      set({ status: "ready" });
    } catch (e) {
      set({ status: "error", error: errMsg(e) });
    }
  },

  restart: async () => {
    try {
      await relaunchApp();
    } catch (e) {
      set({ status: "error", error: errMsg(e) });
    }
  },

  openDialog: () => set({ dialogOpen: true }),
  closeDialog: () => set({ dialogOpen: false }),
  reset: () =>
    set({ status: "idle", error: null, progress: null, dialogOpen: false, targetStatus: "unknown" }),
}));
