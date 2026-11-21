/**
 * Workspace Git clone task ownership.
 *
 * The task lives in the store rather than the dialog so closing the import
 * dialog never cancels a clone and reopening restores the exact progress. The
 * workspace is created here, from the completion path, so a background clone
 * still publishes its workspace when no dialog is mounted.
 */
import { create } from "zustand";
import { t } from "../lib/i18n";
import {
  gitCloneCancel,
  gitCloneDefaults,
  gitCloneRepository,
  listenGitCloneProgress,
  newGitCloneTaskId,
  type GitCloneDefaults,
  type GitClonePhase,
  type GitCloneProgress,
  type GitCloneRequest,
  type GitCloneResult,
} from "../lib/gitClone";
import { useAppStore } from "./appStore";
import { revealWorkspaceFolder } from "../components/workspace/workspaceFolderReveal";
import { useWorkspacePlatformStore } from "./workspacePlatformStore";
import { recentWorkspaceIdFromParts } from "./app/recentWorkspaces";

export type GitCloneTaskPhase = GitClonePhase | "cancelling";

export interface GitCloneTask {
  taskId: string;
  request: GitCloneRequest;
  phase: GitCloneTaskPhase;
  percent: number | null;
  indeterminate: boolean;
  message: string;
  objectsDone: number | null;
  objectsTotal: number | null;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  result: GitCloneResult | null;
  cancelRequested: boolean;
}

export interface GitCloneState {
  open: boolean;
  defaults: GitCloneDefaults | null;
  defaultsStatus: "idle" | "loading" | "ready" | "error";
  defaultsError: string | null;
  task: GitCloneTask | null;
  openDialog: () => void;
  closeDialog: () => void;
  loadDefaults: (force?: boolean) => Promise<void>;
  startClone: (request: GitCloneRequest) => Promise<void>;
  cancelClone: () => Promise<void>;
  resetTask: () => void;
}

const TERMINAL_PHASES = new Set<GitCloneTaskPhase>(["completed", "failed", "cancelled"]);
let defaultsPromise: Promise<void> | null = null;
let unlistenPromise: Promise<() => void> | null = null;

function isTaskActive(task: GitCloneTask | null): task is GitCloneTask {
  return Boolean(task && !TERMINAL_PHASES.has(task.phase));
}

function ensureProgressListener(): void {
  if (unlistenPromise || typeof window === "undefined") return;
  unlistenPromise = listenGitCloneProgress((progress: GitCloneProgress) => {
    const current = useGitCloneStore.getState().task;
    if (!current || current.taskId !== progress.taskId) return;
    useGitCloneStore.setState({
      task: {
        ...current,
        phase: progress.phase,
        percent: progress.percent,
        indeterminate: progress.indeterminate,
        message: progress.message,
        objectsDone: progress.objectsDone,
        objectsTotal: progress.objectsTotal,
      },
    });
  }).catch(() => {
    unlistenPromise = null;
    return () => undefined;
  });
}

function applyCloneResult(request: GitCloneRequest, result: GitCloneResult): void {
  const name = request.workspaceName.trim() || result.repoRoot.split(/[\\/]/).filter(Boolean).pop() || "Workspace";
  const platform = useWorkspacePlatformStore.getState();
  const workspace = platform.createWorkspace({ name, rootPath: result.repoRoot });
  const root = workspace.rootFolders[0];
  const app = useAppStore.getState();
  app.setActiveSideTab("workspaces");
  app.setSidebarCollapsed(false);
  platform.setActiveWorkspace(workspace.id);
  if (root) {
    revealWorkspaceFolder(workspace.id, root.id);
    app.upsertRecentWorkspace({
      id: recentWorkspaceIdFromParts([{
        id: root.id,
        name: root.name,
        path: root.path,
        kind: "git",
      }], []),
      name: workspace.name,
      roots: [{ id: root.id, name: root.name, path: root.path, kind: "git" }],
      looseFiles: [],
      lastOpenedAt: Date.now(),
      lastActiveFile: null,
      isGitRepo: true,
    });
  }
  app.setStatusMessage(t("gitClone.completedStatus", { name: workspace.name }));
}

export const useGitCloneStore = create<GitCloneState>((set, get) => ({
  open: false,
  defaults: null,
  defaultsStatus: "idle",
  defaultsError: null,
  task: null,

  openDialog: () => {
    set({ open: true });
    void get().loadDefaults();
  },

  closeDialog: () => set({ open: false }),

  loadDefaults: async (force = false) => {
    const current = get();
    if (!force && current.defaultsStatus === "ready" && current.defaults) return;
    if (defaultsPromise) return defaultsPromise;
    set({ defaultsStatus: "loading", defaultsError: null });
    defaultsPromise = gitCloneDefaults()
      .then((defaults) => {
        set({ defaults, defaultsStatus: "ready", defaultsError: null });
      })
      .catch((cause: unknown) => {
        set({
          defaultsStatus: "error",
          defaultsError: cause instanceof Error ? cause.message : String(cause),
        });
      })
      .finally(() => {
        defaultsPromise = null;
      });
    return defaultsPromise;
  },

  startClone: async (request) => {
    const current = get();
    if (isTaskActive(current.task)) {
      throw new Error(t("gitClone.duplicateTask"));
    }
    ensureProgressListener();
    const task: GitCloneTask = {
      taskId: request.taskId,
      request,
      phase: "preparing",
      percent: null,
      indeterminate: true,
      message: "",
      objectsDone: null,
      objectsTotal: null,
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      result: null,
      cancelRequested: false,
    };
    set({ task, open: true });
    try {
      const result = await gitCloneRepository(request);
      applyCloneResult(request, result);
      set((state) => state.task && state.task.taskId === request.taskId ? {
        task: {
          ...state.task,
          phase: "completed",
          percent: 100,
          indeterminate: false,
          message: t("gitClone.completed", { path: result.repoRoot }),
          finishedAt: Date.now(),
          result,
          error: null,
        },
      } : state);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const cancelled = get().task?.cancelRequested && /cancel/i.test(message);
      set((state) => state.task && state.task.taskId === request.taskId ? {
        task: {
          ...state.task,
          phase: cancelled ? "cancelled" : "failed",
          indeterminate: true,
          message: cancelled ? t("gitClone.cancelled") : t("gitClone.failed"),
          finishedAt: Date.now(),
          error: cancelled ? null : message,
        },
      } : state);
    }
  },

  cancelClone: async () => {
    const current = get().task;
    if (!current || !isTaskActive(current)) return;
    set((state) => state.task ? {
      task: { ...state.task, phase: "cancelling", cancelRequested: true, message: t("gitClone.cancelling") },
    } : state);
    try {
      await gitCloneCancel(current.taskId);
    } catch {
      // The process may have already exited; its failed/completed result owns
      // the final task state.
    }
  },

  resetTask: () => {
    const current = get().task;
    if (current && isTaskActive(current)) return;
    set({ task: null });
  },
}));

/** Test hook: forget module-level listener/default promises between cases. */
export function resetGitCloneStoreForTests(): void {
  defaultsPromise = null;
  unlistenPromise = null;
  useGitCloneStore.setState({
    open: false,
    defaults: null,
    defaultsStatus: "idle",
    defaultsError: null,
    task: null,
  });
}

export { newGitCloneTaskId };
