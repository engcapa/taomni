import { create } from "zustand";
import {
  getUpdaterPlatform,
  checkForUpdate,
  downloadAndInstall,
  installDownloadedUpdate,
  discardDownloadedUpdate,
  isSocksCapUpgradeAuthorizationRequired,
  isSudoAuthenticationError,
  relaunchApp,
  type DownloadProgress,
} from "../lib/updateService";
import { t as tr } from "../lib/i18n";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "authorizing"
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
  authorizationBusy: boolean;
  authorizationError: string | null;

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
  cancelDownload: () => void;
  authorizeInstall: (sudoPassword: string) => Promise<void>;
  cancelAuthorization: () => void;
  restart: () => Promise<void>;
  openDialog: () => void;
  closeDialog: () => void;
  reset: () => void;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

let operationGeneration = 0;
let activeDownload: AbortController | null = null;

function isTransitioning(status: UpdateStatus): boolean {
  return status === "downloading" || status === "installing" || status === "authorizing" || status === "ready";
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
  authorizationBusy: false,
  authorizationError: null,
  os: null,
  nativeTarget: null,
  recommendedTarget: null,
  candidates: [],
  isRosetta: false,
  selectedTarget: null,
  targetStatus: "unknown",

  check: async (opts) => {
    const manual = opts?.manual ?? false;
    // A check is already in flight. Don't kick off a second, concurrent check
    // — it would fire duplicate network requests and could race the first
    // one's result. A manual re-trigger just re-surfaces the existing
    // "checking…" dialog; an auto/periodic trigger quietly no-ops.
    if (get().status === "checking" || isTransitioning(get().status)) {
      if (manual) set({ dialogOpen: true });
      return;
    }
    // Manual checks (the About "Check for updates" button) open the window
    // right away so the user immediately sees a non-modal "checking…" state
    // instead of staring at nothing until the network round-trip finishes.
    // Startup/periodic checks stay silent (dialogOpen left untouched).
    const generation = ++operationGeneration;
    set({ status: "checking", manual, error: null, progress: null, targetStatus: "unknown", dialogOpen: manual || get().dialogOpen });
    try {
      const platform = await getUpdaterPlatform();
      if (generation !== operationGeneration) return;
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
      if (generation !== operationGeneration) return;
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
      if (generation !== operationGeneration) return;
      set({ status: "error", error: errMsg(e), dialogOpen: manual || get().dialogOpen });
    }
  },

  setSelectedTarget: async (target) => {
    if (isTransitioning(get().status)) return;
    const generation = ++operationGeneration;
    set({ selectedTarget: target, targetStatus: "checking", error: null });
    try {
      const found = await checkForUpdate(target);
      if (generation !== operationGeneration || get().selectedTarget !== target) return; // superseded by a newer pick
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
      if (generation !== operationGeneration || get().selectedTarget !== target) return;
      set({ targetStatus: "unavailable", error: errMsg(e) });
    }
  },

  startDownload: async () => {
    if (get().status !== "available" || get().targetStatus !== "ok") return;
    const generation = ++operationGeneration;
    const controller = new AbortController();
    activeDownload = controller;
    const isCurrent = () => generation === operationGeneration && !controller.signal.aborted;
    const { selectedTarget, candidates } = get();
    set({
      status: "downloading",
      error: null,
      progress: { downloaded: 0, total: null, percent: 0 },
      authorizationBusy: false,
      authorizationError: null,
    });
    try {
      const downloadTarget = candidates.length > 1 ? (selectedTarget ?? undefined) : undefined;
      await downloadAndInstall(downloadTarget, (p) => {
        if (isCurrent()) set({ progress: p });
      }, {
        signal: controller.signal,
        onInstalling: () => { if (isCurrent()) set({ status: "installing" }); },
      });
      if (isCurrent()) set({ status: "ready" });
    } catch (e) {
      if (!isCurrent()) return;
      if (isSocksCapUpgradeAuthorizationRequired(e)) {
        set({ status: "authorizing", authorizationError: null });
      } else {
        set({ status: "error", error: errMsg(e) });
      }
    } finally {
      if (activeDownload === controller) activeDownload = null;
    }
  },

  cancelDownload: () => {
    if (get().status !== "downloading") return;
    ++operationGeneration;
    activeDownload?.abort();
    activeDownload = null;
    set({ status: "available", progress: null, error: null, dialogOpen: false });
  },

  authorizeInstall: async (sudoPassword) => {
    if (get().status !== "authorizing" || get().authorizationBusy) return;
    const generation = ++operationGeneration;
    const { selectedTarget, candidates } = get();
    const downloadTarget = candidates.length > 1 ? (selectedTarget ?? undefined) : undefined;
    set({ authorizationBusy: true, authorizationError: null });
    try {
      await installDownloadedUpdate(downloadTarget, sudoPassword);
      if (generation !== operationGeneration) return;
      set({ status: "ready", authorizationBusy: false, authorizationError: null });
    } catch (e) {
      if (generation !== operationGeneration) return;
      if (isSudoAuthenticationError(e)) {
        set({
          status: "authorizing",
          authorizationBusy: false,
          authorizationError: tr("sockscap.rootPromptIncorrectPassword"),
        });
      } else {
        set({
          status: "error",
          error: errMsg(e),
          authorizationBusy: false,
          authorizationError: null,
        });
      }
    }
  },

  cancelAuthorization: () => {
    if (get().status !== "authorizing" || get().authorizationBusy) return;
    ++operationGeneration;
    const { candidates, selectedTarget } = get();
    void discardDownloadedUpdate(candidates.length > 1 ? (selectedTarget ?? undefined) : undefined);
    set({ status: "available", authorizationBusy: false, authorizationError: null });
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
  reset: () => {
    ++operationGeneration;
    activeDownload?.abort();
    activeDownload = null;
    set({
      status: "idle",
      error: null,
      progress: null,
      authorizationBusy: false,
      authorizationError: null,
      dialogOpen: false,
      targetStatus: "unknown",
    });
  },
}));
