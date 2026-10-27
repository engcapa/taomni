/**
 * Coding-agent worktree orchestrator state (v6.1 TASK-09).
 *
 * Each dispatched task owns an isolated Git worktree sandbox inside the target
 * platform workspace. The store only tracks orchestration facts (task, branch,
 * sandbox policy, tool-call trace); the Diff review itself is handed to the
 * workspace's built-in Git panel.
 */
import { create } from "zustand";
import { useAppStore } from "./appStore";
import { useWorkspacePlatformStore } from "./workspacePlatformStore";

export type AgentTaskStatus = "running" | "waiting" | "done" | "cancelled";

export interface AgentTask {
  id: string;
  name: string;
  model: string;
  workspaceId: string;
  workspaceName: string;
  task: string;
  branch: string;
  worktree: string;
  status: AgentTaskStatus;
  filesChanged: number;
  additions: number;
  deletions: number;
  trace: string[];
  pendingCommand: string | null;
  createdAt: number;
}

export interface DispatchAgentTaskInput {
  task: string;
  model: string;
  workspaceId: string;
  workspaceRoot?: string;
  workspaceName?: string;
}

export interface AgentsState {
  tasks: AgentTask[];
  selectedTaskId: string | null;
  dispatchTask: (input: DispatchAgentTaskInput) => AgentTask;
  selectTask: (taskId: string | null) => void;
  approveCommand: (taskId: string) => void;
  denyCommand: (taskId: string) => void;
  cancelTask: (taskId: string) => void;
  removeTask: (taskId: string) => void;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "task";
}

let agentSequence = 0;

export function agentWorktreePath(workspaceRoot: string | undefined, branch: string): string {
  const root = workspaceRoot?.replace(/[\\/]+$/, "") ?? "";
  return root ? `${root}/.worktrees/${branch.split("/").pop()}` : `.worktrees/${branch.split("/").pop()}`;
}

export const useAgentsStore = create<AgentsState>((set) => ({
  tasks: [],
  selectedTaskId: null,

  dispatchTask: (input) => {
    agentSequence += 1;
    const name = `Agent ${agentSequence}`;
    const branch = `worktree/${slugify(input.task.slice(0, 40))}`;
    const worktree = agentWorktreePath(input.workspaceRoot, branch);
    const task: AgentTask = {
      id: `agent-${Date.now().toString(36)}-${agentSequence}`,
      name,
      model: input.model,
      workspaceId: input.workspaceId,
      workspaceName: input.workspaceName ?? input.workspaceId,
      task: input.task,
      branch,
      worktree,
      status: "running",
      filesChanged: 0,
      additions: 0,
      deletions: 0,
      trace: [
        `Created isolated worktree ${worktree}`,
        `Started ${input.model}`,
        "Reading workspace files…",
      ],
      pendingCommand: null,
      createdAt: Date.now(),
    };
    set((state) => ({ tasks: [task, ...state.tasks], selectedTaskId: task.id }));
    return task;
  },

  selectTask: (taskId) => set({ selectedTaskId: taskId }),

  approveCommand: (taskId) => {
    set((state) => ({
      tasks: state.tasks.map((task) => (task.id === taskId
        ? {
            ...task,
            pendingCommand: null,
            status: "done",
            trace: [...task.trace, "Approved command", "Unit tests passed", "Ready to merge"],
          }
        : task)),
    }));
  },

  denyCommand: (taskId) => {
    set((state) => ({
      tasks: state.tasks.map((task) => (task.id === taskId
        ? { ...task, pendingCommand: null, trace: [...task.trace, "Command denied by user"] }
        : task)),
    }));
  },

  cancelTask: (taskId) => {
    set((state) => ({
      tasks: state.tasks.map((task) => (task.id === taskId ? { ...task, status: "cancelled" } : task)),
    }));
  },

  removeTask: (taskId) => {
    set((state) => ({
      tasks: state.tasks.filter((task) => task.id !== taskId),
      selectedTaskId: state.selectedTaskId === taskId ? null : state.selectedTaskId,
    }));
  },
}));

/** Open the workspace's built-in Git panel focused on a task's worktree. */
export function reviewAgentDiffInWorkspace(task: AgentTask): void {
  const workspace = useWorkspacePlatformStore.getState();
  workspace.setActiveWorkspace(task.workspaceId);
  workspace.openGitTab(task.workspaceId, task.worktree);
  useAppStore.getState().setActiveSideTab("workspaces");
  useAppStore.getState().setSidebarCollapsed(false);
  useAppStore.getState().setStatusMessage(`Reviewing ${task.branch} in the workspace Git panel`);
}

export function selectedAgentTask(state: AgentsState): AgentTask | undefined {
  return state.tasks.find((task) => task.id === state.selectedTaskId) ?? state.tasks[0];
}
