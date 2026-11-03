import { create } from "zustand";
import { agentProjectKey, sameAgentProject } from "../lib/orchestrationProject";
import {
  cancelAgentRun, createAgentRun, getAgentRun, getAgentSettings, listAgentRuns,
  recoverAgentRun, saveAgentSettings, startAgentRun,
  type AgentIntent, type AgentRun, type AgentSettings,
} from "../lib/ipc/orchestration";

const SELECTION_KEY = "taomni.orchestration.selection.v1";
const PROJECT_KEY = "taomni.orchestration.project.v1";
function savedProject(): string {
  try { return localStorage.getItem(PROJECT_KEY) ?? ""; }
  catch { return ""; }
}
const initialProject = savedProject();
export const isAgentRunActive = (run: AgentRun) => ["preparing", "running", "stopping"].includes(run.status);

function savedSelection(projectPath: string): string | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? "{}");
    if (!value || typeof value !== "object") return null;
    const saved = value as Record<string, unknown>;
    const id = saved[agentProjectKey(projectPath)] ?? Object.entries(saved).find(([path]) => sameAgentProject(path, projectPath))?.[1];
    return typeof id === "string" ? id : null;
  } catch { return null; }
}

function persistSelection(projectPath: string, runId: string | null) {
  if (!projectPath) return;
  try {
    const previous: unknown = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? "{}");
    const selections = previous && typeof previous === "object" ? previous : {};
    localStorage.setItem(SELECTION_KEY, JSON.stringify({ ...selections, [agentProjectKey(projectPath)]: runId }));
  } catch { /* Runtime state remains usable when storage is unavailable. */ }
}

function mergeRuns(current: AgentRun[], incoming: AgentRun[]): AgentRun[] {
  const byId = new Map(current.map((run) => [run.id, run]));
  for (const run of incoming) {
    const previous = byId.get(run.id);
    if (!previous || run.revision >= previous.revision) byId.set(run.id, run);
  }
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}

interface SubmitGoal {
  projectPath: string;
  goal: string;
  intent: AgentIntent;
  sourcePaths: string[];
}

interface OrchestrationState {
  settings: AgentSettings | null;
  runs: AgentRun[];
  projectPath: string;
  selectedRunId: string | null;
  loading: boolean;
  saving: boolean;
  pending: string | null;
  error: string | null;
  setProject: (path: string) => void;
  selectRun: (id: string | null) => void;
  clearError: () => void;
  load: () => Promise<void>;
  refreshRuntime: () => Promise<void>;
  refreshRun: (id: string) => Promise<void>;
  saveSettings: (settings: AgentSettings) => Promise<void>;
  submit: (input: SubmitGoal) => Promise<AgentRun | null>;
  start: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  recover: (id: string) => Promise<void>;
}

// Promises deduplicate StrictMode/reconnect requests, never own the native task.
let loadingPromise: Promise<void> | null = null;
let refreshPromise: Promise<void> | null = null;
const refreshingRuns = new Map<string, Promise<void>>();

export const useOrchestrationStore = create<OrchestrationState>((set, get) => {
  let selectionGeneration = 0;
  let retrySubmission: { fingerprint: string; commandId: string } | null = null;
  const acceptRun = (run: AgentRun) => set((state) => ({ runs: mergeRuns(state.runs, [run]) }));
  const mutate = async (id: string, operation: "start" | "cancel" | "recover") => {
    if (get().pending) return;
    const run = get().runs.find((entry) => entry.id === id);
    if (!run || (operation === "start" && run.status !== "planned")
      || (operation === "recover" && (run.status !== "partial" || run.recoveryCount > 0))) return;
    set({ pending: `${operation}:${id}`, error: null });
    try {
      const updated = operation === "start"
        ? await startAgentRun(id, run.revision)
        : operation === "recover"
          ? await recoverAgentRun(id, run.revision)
          : await cancelAgentRun(id);
      acceptRun(updated);
    } catch (error) {
      set({ error: String(error) });
      throw error;
    } finally { set({ pending: null }); }
  };

  return {
    settings: null,
    runs: [],
    projectPath: initialProject,
    selectedRunId: savedSelection(initialProject),
    loading: false,
    saving: false,
    pending: null,
    error: null,
    setProject: (projectPath) => {
      if (get().projectPath !== projectPath) {
        selectionGeneration += 1;
        try { localStorage.setItem(PROJECT_KEY, projectPath); }
        catch { /* A renderer can still use the selected workspace root. */ }
        set({ projectPath, selectedRunId: savedSelection(projectPath) });
      }
    },
    selectRun: (selectedRunId) => {
      const { projectPath, runs } = get();
      if (selectedRunId && !runs.some((run) => run.id === selectedRunId && sameAgentProject(run.projectPath, projectPath))) return;
      selectionGeneration += 1;
      persistSelection(projectPath, selectedRunId);
      set({ selectedRunId, error: null });
    },
    clearError: () => set({ error: null }),
    load: () => {
      if (loadingPromise) return loadingPromise;
      set({ loading: true, error: null });
      loadingPromise = (async () => {
        const [settings, runs] = await Promise.allSettled([getAgentSettings(), listAgentRuns()]);
        if (settings.status === "fulfilled") {
          set((state) => ({ settings: !state.settings || settings.value.revision >= state.settings.revision ? settings.value : state.settings }));
        }
        if (runs.status === "fulfilled") set((state) => ({ runs: mergeRuns(state.runs, runs.value) }));
        const errors = [settings, runs].flatMap((result) => result.status === "rejected" ? [String(result.reason)] : []);
        set({ error: errors.length ? errors.join("\n") : null, loading: false });
      })().finally(() => { loadingPromise = null; });
      return loadingPromise;
    },
    refreshRuntime: () => {
      if (refreshPromise) return refreshPromise;
      refreshPromise = listAgentRuns()
        .then((runs) => { set((state) => ({ runs: mergeRuns(state.runs, runs) })); })
        .catch((error: unknown) => { set({ error: String(error) }); throw error; })
        .finally(() => { refreshPromise = null; });
      return refreshPromise;
    },
    refreshRun: (id) => {
      const existing = refreshingRuns.get(id);
      if (existing) return existing;
      const promise = getAgentRun(id).then(acceptRun)
        .catch((error: unknown) => { set({ error: String(error) }); throw error; })
        .finally(() => { refreshingRuns.delete(id); });
      refreshingRuns.set(id, promise);
      return promise;
    },
    saveSettings: async (settings) => {
      if (get().saving) return;
      set({ saving: true, error: null });
      try {
        const saved = await saveAgentSettings(settings, settings.revision);
        set({ settings: saved });
      } catch (error) {
        set({ error: String(error) });
        throw error;
      } finally { set({ saving: false }); }
    },
    submit: async ({ projectPath, goal, intent, sourcePaths }) => {
      const { settings, pending } = get();
      if (pending || !settings || !projectPath || !goal.trim()) return null;
      const submittedSelection = selectionGeneration;
      const submission = { projectPath, goal: goal.trim(), intent, sourcePaths, expectedSettingsRevision: settings.revision };
      const fingerprint = JSON.stringify(submission);
      const commandId = retrySubmission?.fingerprint === fingerprint ? retrySubmission.commandId : crypto.randomUUID();
      // A failed/ambiguous transport must reuse the idempotency key on explicit retry.
      retrySubmission = { fingerprint, commandId };
      set({ pending: "create", error: null });
      try {
        const run = await createAgentRun({ commandId, ...submission });
        retrySubmission = null;
        acceptRun(run);
        // A slow creation must not steal selection after switching projects.
        if (get().projectPath === projectPath && selectionGeneration === submittedSelection) {
          persistSelection(projectPath, run.id);
          set({ selectedRunId: run.id });
        }
        return run;
      } catch (error) {
        set({ error: String(error) });
        return null;
      } finally { set({ pending: null }); }
    },
    start: (id) => mutate(id, "start"),
    cancel: (id) => mutate(id, "cancel"),
    recover: (id) => mutate(id, "recover"),
  };
});
