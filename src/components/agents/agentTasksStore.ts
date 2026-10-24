import { create } from "zustand";

/**
 * Coding-agent orchestration state (v6.1 TASK-09). Tasks model parallel
 * agents running on isolated Git worktrees of a platform workspace; the
 * store intentionally lives outside appStore because agent instances never
 * touch the global tab runtime.
 */
export type AgentTaskStatus = "waiting" | "running" | "done";

export interface AgentTask {
  id: string;
  title: string;
  workspaceId: string;
  worktreePath: string;
  branch: string;
  status: AgentTaskStatus;
  /** Cumulative diff stats rendered in the review panel. */
  changes: { files: number; insertions: number; deletions: number };
  /** Latest tool-call trace lines streamed from the agent. */
  trace: string[];
}

interface AgentTasksState {
  tasks: AgentTask[];
  selectedTaskId: string | null;
  dispatchTask: (input: { title: string; workspaceId: string; worktreePath?: string; branch?: string }) => AgentTask;
  selectTask: (id: string) => void;
  updateTask: (id: string, patch: Partial<Omit<AgentTask, "id">>) => void;
}

const AGENT_TASKS_STORAGE_KEY = "taomni.agentTasks.v1";

function nextBranch(index: number): string {
  return `agent/task-${index + 1}`;
}

function sanitizeTasks(raw: unknown): AgentTask[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((task): task is AgentTask => (
    !!task
    && typeof (task as AgentTask).id === "string"
    && typeof (task as AgentTask).title === "string"
    && typeof (task as AgentTask).branch === "string"
  ));
}

function loadTasks(): AgentTask[] {
  if (typeof window === "undefined") return [];
  try {
    return sanitizeTasks(JSON.parse(window.localStorage.getItem(AGENT_TASKS_STORAGE_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

function persistTasks(tasks: AgentTask[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AGENT_TASKS_STORAGE_KEY, JSON.stringify(tasks));
  } catch {
    // Storage quota or privacy mode: keep the in-memory tasks authoritative.
  }
}

export const useAgentTasksStore = create<AgentTasksState>((set) => ({
  tasks: loadTasks(),
  selectedTaskId: null,

  dispatchTask: ({ title, workspaceId, worktreePath, branch }) => {
    const task: AgentTask = {
      id: `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      title: title.trim() || "Agent task",
      workspaceId,
      worktreePath: worktreePath ?? "",
      branch: branch ?? nextBranch(useAgentTasksStore.getState().tasks.length),
      status: "waiting",
      changes: { files: 0, insertions: 0, deletions: 0 },
      trace: [],
    };
    set((state) => {
      const tasks = [...state.tasks, task];
      persistTasks(tasks);
      return { tasks, selectedTaskId: task.id };
    });
    return task;
  },

  selectTask: (id) => set((state) => (state.selectedTaskId === id ? state : { selectedTaskId: id })),

  updateTask: (id, patch) => set((state) => {
    const tasks = state.tasks.map((task) => (task.id === id ? { ...task, ...patch } : task));
    persistTasks(tasks);
    return { tasks };
  }),
}));

