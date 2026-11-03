import type { AgentRun, AgentSettings, AgentSubmission, AgentContextPreview } from "../../lib/ipc/orchestration";
import { vfsReadText } from "../localVfs";

const SETTINGS = "taomni.orchestration.settings";
const RUNS = "taomni.orchestration.runs";
const clone = <T>(value: T): T => structuredClone(value);
export function defaultAgentSettings(): AgentSettings {
  return { revision: 1, name: "日常开发", planningResourceId: "", reviewResourceId: "", workerResourceIds: [], concurrency: 2, preferPackedPlanning: true, resources: [] };
}
function settings(): AgentSettings {
  const raw = localStorage.getItem(SETTINGS);
  return raw ? JSON.parse(raw) as AgentSettings : defaultAgentSettings();
}
function runs(): AgentRun[] { return JSON.parse(localStorage.getItem(RUNS) || "[]") as AgentRun[]; }
function saveRuns(value: AgentRun[]) { localStorage.setItem(RUNS, JSON.stringify(value)); }
function getRun(id: string): AgentRun {
  const run = runs().find((item) => item.id === id);
  if (!run) throw new Error("RUN_NOT_FOUND");
  return run;
}
function update(id: string, change: (run: AgentRun) => void): AgentRun {
  const all = runs();
  const run = all.find((item) => item.id === id);
  if (!run) throw new Error("RUN_NOT_FOUND");
  change(run);
  run.revision++;
  saveRuns(all);
  return clone(run);
}
async function context(project: string, paths: string[]): Promise<AgentContextPreview> {
  if (!project) throw new Error("PROJECT_REQUIRED");
  const sources = [];
  for (const path of [...new Set(["AGENTS.md", ...paths])]) {
    if (path.startsWith("/") || path.includes("..") || /(^|\/)\.env/.test(path)) throw new Error("CONTEXT_OUTSIDE_PROJECT");
    let content: string;
    try { content = await vfsReadText(project.replace(/\/$/, "") + "/" + path); }
    catch { if (path === "AGENTS.md") continue; throw new Error("CONTEXT_MISSING: " + path); }
    sources.push({ id: "src-" + (sources.length + 1), path, content, hash: "browser-preview-only" });
  }
  return { sources, estimatedInputTokens: sources.reduce((n, source) => n + Math.ceil(source.content.length / 3), 0), estimateMethod: "browser_preview_not_native", warnings: ["Browser preview uses virtual files and deterministic candidate data; no native networking or worker has been verified."] };
}
function finishPreview(id: string, recovery: boolean) {
  const run = getRun(id);
  const resourceId = run.intent === "review" ? run.settingsSnapshot.reviewResourceId : run.settingsSnapshot.planningResourceId;
  const resource = run.settingsSnapshot.resources.find((item) => item.id === resourceId);
  const partial = !recovery && resource?.model.includes("partial");
  return update(id, (current) => {
    current.requestCount++;
    const ids = current.tasks.filter((task) => !current.artifacts.some((item) => item.itemId === task.id)).map((task) => task.id);
    for (const itemId of partial ? ids.slice(0, -1) : ids) {
      const content = "Browser-only candidate for " + itemId + ". This fixture does not prove native execution or passing tests.";
      current.artifacts.push({ id: crypto.randomUUID(), itemId, name: itemId + ".md", format: "markdown", content, hash: "browser-preview-only", status: "candidate" });
      const task = current.tasks.find((item) => item.id === itemId);
      if (task) task.status = "candidate";
    }
    current.status = partial ? "partial" : "candidate";
    current.error = partial ? "INCOMPLETE_PACK: browser fixture retained complete prefix candidates" : null;
    current.events.push({ sequence: current.events.length + 1, kind: "browser_fixture", message: "Deterministic browser preview; not real LLM or harness evidence", createdAt: Date.now() });
  });
}
export async function invokeOrchestration(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const id = String(args.runId || "");
  switch (cmd) {
    case "orchestration_get_settings": return settings();
    case "orchestration_save_settings": {
      const current = settings();
      if (current.revision !== args.expectedRevision) throw new Error("STALE_SETTINGS");
      const next = clone(args.settings as AgentSettings);
      if (!next.name.trim() || !Number.isInteger(next.concurrency) || next.concurrency < 1 || next.concurrency > 4) throw new Error("INVALID_SETTINGS");
      if (new Set(next.resources.map((resource) => resource.id)).size !== next.resources.length) throw new Error("INVALID_SETTINGS");
      if (next.resources.some((resource) => !Number.isFinite(resource.costCoefficient) || resource.costCoefficient <= 0 || (resource.keyRef && !resource.keyRef.startsWith("vault:")))) throw new Error("INVALID_SETTINGS");
      const ids = new Set(next.resources.map((resource) => resource.id));
      if ([next.planningResourceId, next.reviewResourceId, ...next.workerResourceIds].some((id) => id && !ids.has(id))) throw new Error("INVALID_SETTINGS");
      if (next.workerResourceIds.some((id) => !next.resources.some((resource) => resource.id === id && resource.kind === "worker"))) throw new Error("INVALID_SETTINGS");
      next.revision = current.revision + 1;
      next.name = next.name.trim();
      localStorage.setItem(SETTINGS, JSON.stringify(next));
      return next;
    }
    case "orchestration_list_runs": return runs();
    case "orchestration_get_run": return getRun(id);
    case "orchestration_preview_context": return context(String(args.projectPath || ""), args.sourcePaths as string[] || []);
    case "orchestration_create_run": {
      const submission = args.submission as AgentSubmission;
      const existing = runs().find((run) => run.events.some((event) => event.message === "command:" + submission.commandId));
      if (existing) return existing;
      const config = settings();
      if (config.revision !== submission.expectedSettingsRevision) throw new Error("STALE_SETTINGS");
      if (!submission.goal.trim()) throw new Error("INVALID_TASK");
      const selected = submission.intent === "plan" ? config.planningResourceId : submission.intent === "review" ? config.reviewResourceId : config.workerResourceIds[0];
      if (!config.resources.some((resource) => resource.id === selected)) throw new Error("RESOURCE_REQUIRED: configure shared development resources");
      const preview = await context(submission.projectPath, submission.sourcePaths);
      const tasks = submission.intent === "plan" ? ["design", "contract", "tests"] : [submission.intent === "review" ? "review" : "implementation"];
      const run: AgentRun = { id: crypto.randomUUID(), revision: 1, projectPath: submission.projectPath, title: submission.goal.slice(0, 60), goal: submission.goal, intent: submission.intent, status: "planned", settingsSnapshot: clone(config), tasks: tasks.map((taskId) => ({ id: taskId, title: taskId, status: "pending", dependencies: [] })), sources: preview.sources, artifacts: [], events: [{ sequence: 1, kind: "browser_submission", message: "command:" + submission.commandId, createdAt: Date.now() }], requestCount: 0, recoveryCount: 0, error: null, worktreePath: null, createdAt: Date.now() };
      saveRuns([run, ...runs()]); return run;
    }
    case "orchestration_start_run": {
      const run = getRun(id);
      if (run.revision !== args.expectedRevision || run.status !== "planned") throw new Error("STALE_REVISION");
      const selected = run.intent === "plan" ? run.settingsSnapshot.planningResourceId : run.intent === "review" ? run.settingsSnapshot.reviewResourceId : run.settingsSnapshot.workerResourceIds[0];
      if (!settings().resources.some((resource) => resource.id === selected)) throw new Error("RESOURCE_REVOKED");
      if (run.intent === "develop") return update(id, (current) => { current.status = "blocked"; current.error = "Native worker execution is unavailable in browser preview."; });
      return finishPreview(id, false);
    }
    case "orchestration_recover_run": {
      const run = getRun(id);
      if (run.revision !== args.expectedRevision || run.status !== "partial" || run.recoveryCount !== 0) throw new Error("RECOVERY_UNAVAILABLE");
      update(id, (current) => { current.recoveryCount++; }); return finishPreview(id, true);
    }
    case "orchestration_cancel_run": {
      const run = getRun(id);
      if (run.status === "cancelled") return run;
      if (!["planned", "blocked", "preparing", "running", "stopping"].includes(run.status)) throw new Error("RUN_NOT_CANCELLABLE");
      return update(id, (current) => { current.status = "cancelled"; });
    }
    case "orchestration_active_count": return runs().filter((run) => ["running", "preparing", "stopping"].includes(run.status)).length;
    default: throw new Error("Unknown orchestration command: " + cmd);
  }
}
