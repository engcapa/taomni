import { create } from "zustand";

/** Git status summary shown in the workspace sidebar bar and the rail badge. */
export interface WorkspaceGitSummary {
  repoRoot: string;
  branch: string;
  changeCount: number;
  loading: boolean;
}

export const EMPTY_WORKSPACE_GIT_SUMMARY: WorkspaceGitSummary = {
  repoRoot: "",
  branch: "",
  changeCount: 0,
  loading: false,
};

interface WorkspaceGitSummaryState {
  summary: WorkspaceGitSummary;
  setSummary: (summary: WorkspaceGitSummary) => void;
}

export const useWorkspaceGitSummaryStore = create<WorkspaceGitSummaryState>((set) => ({
  summary: EMPTY_WORKSPACE_GIT_SUMMARY,
  setSummary: (summary) => set({ summary }),
}));
