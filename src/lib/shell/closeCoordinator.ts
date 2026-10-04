import type { CloseChoice, CloseRisk } from "./types";

export interface CloseAdapter {
  getRisks(exit: boolean): Promise<CloseRisk[]>;
  resolve(risk: CloseRisk, choice: CloseChoice, signal: AbortSignal): Promise<void>;
  flush(signal: AbortSignal): Promise<void>;
}
export interface CloseTarget { id: string; title: string; adapter: CloseAdapter; commit(): void | Promise<void> }
export interface ClosePlanItem { target: CloseTarget; risks: CloseRisk[] }
export interface CloseResult { status: "closed" | "cancelled" | "partial" | "failed"; closed: string[]; failed: Array<{ id: string; error: string }> }
export type ClosePrompt = (items: ClosePlanItem[], errors: CloseResult["failed"]) => Promise<Record<string, CloseChoice> | null>;
export class CloseCoordinator {
  private inFlight = new Map<string, Promise<CloseResult>>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private prompt: ClosePrompt) {}
  request(targets: CloseTarget[], exit = false): Promise<CloseResult> {
    const unique = [...new Map(targets.map((target) => [target.id, target])).values()];
    const key = `${exit ? "exit" : "tabs"}:${unique.map((target) => target.id).sort().join("\0")}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const pending = this.queue.catch(() => undefined).then(() => this.execute(unique, exit));
    this.queue = pending;
    this.inFlight.set(key, pending);
    const release = () => { if (this.inFlight.get(key) === pending) this.inFlight.delete(key); };
    void pending.then(release, release);
    return pending;
  }
  private async execute(targets: CloseTarget[], exit: boolean): Promise<CloseResult> {
    const signal = new AbortController().signal;
    const closed: string[] = [], failed: CloseResult["failed"] = [];
    let items: ClosePlanItem[];
    try { items = await Promise.all(targets.map(async (target) => ({ target, risks: await target.adapter.getRisks(exit) }))); }
    catch (error) { return { status: "failed", closed, failed: [{ id: "prepare", error: String(error) }] }; }
    let choices: Record<string, CloseChoice> = {};
    // App exit has already confirmed the working set. Only unresolved business
    // risks need a second decision; ordinary bulk tab close still reviews its targets.
    if ((!exit && items.length > 1) || items.some((item) => item.risks.length)) {
      const answer = await this.prompt(items, []);
      if (!answer || Object.values(answer).includes("cancel")) return { status: "cancelled", closed, failed };
      choices = answer;
      // Reject incomplete/invalid plans before any irreversible save or commit.
      if (items.some((item) => item.risks.some((risk) => !risk.choices.includes(choices[risk.id] as never) || (exit && choices[risk.id] === "background"))))
        return { status: "cancelled", closed, failed };
    }
    for (const item of items) {
      try {
        // New revisions while a dialog is open require a new explicit decision.
        const current = await item.target.adapter.getRisks(exit);
        if (current.some((risk) => !item.risks.some((old) => old.id === risk.id && old.revision === risk.revision))) {
          const answer = await this.prompt([{ ...item, risks: current }], []);
          if (!answer || current.some((r) => answer[r.id] === "cancel" || !r.choices.includes(answer[r.id] as never) || (exit && answer[r.id] === "background")))
            return { status: closed.length ? "partial" : "cancelled", closed, failed };
          choices = { ...choices, ...answer };
        }
        for (const risk of current) await item.target.adapter.resolve(risk, choices[risk.id], signal);
        let next = await item.target.adapter.getRisks(exit);
        for (let round = 0; next.length && round < 4; round += 1) {
          if (next.some((risk) => current.some((old) => old.id === risk.id && old.revision === risk.revision)))
            throw new Error("The selected action did not resolve the close risk. Retry after correcting the error.");
          const answer = await this.prompt([{ target: item.target, risks: next }], []);
          if (!answer || next.some((r) => !r.choices.includes(answer[r.id] as never) || answer[r.id] === "cancel" || (exit && answer[r.id] === "background")))
            return { status: closed.length ? "partial" : "cancelled", closed, failed };
          for (const risk of next) await item.target.adapter.resolve(risk, answer[risk.id], signal);
          next = await item.target.adapter.getRisks(exit);
        }
        await item.target.adapter.flush(signal);
        // The business adapter must clear resolved risks synchronously before returning.
        const remaining = await item.target.adapter.getRisks(exit);
        if (remaining.length) throw new Error("The target changed before closing; review its current state and retry.");
        await item.target.commit();
        closed.push(item.target.id);
      } catch (error) {
        failed.push({ id: item.target.id, error: String(error) });
        break;
      }
    }
    if (failed.length) await this.prompt([], failed);
    return { status: failed.length ? (closed.length ? "partial" : "failed") : "closed", closed, failed };
  }
}
const adapters = new Map<string, CloseAdapter>();
const surfaceTargets = new Map<string, () => CloseTarget>();
export function registerCloseTarget(id: string, target: () => CloseTarget): () => void { surfaceTargets.set(id, target); return () => { if (surfaceTargets.get(id) === target) surfaceTargets.delete(id); }; }
export function getSurfaceCloseTarget(id: string): CloseTarget | undefined { return surfaceTargets.get(id)?.(); }
export function listSurfaceCloseTargets(): CloseTarget[] { return [...surfaceTargets.values()].map((target) => target()); }
export function registerCloseAdapter(id: string, adapter: CloseAdapter): () => void {
  adapters.set(id, adapter);
  return () => { if (adapters.get(id) === adapter) adapters.delete(id); };
}
export function getCloseAdapter(id: string): CloseAdapter | undefined { return adapters.get(id); }
type TabCloseHandler = (ids: string[], exit?: boolean) => Promise<CloseResult>;
let tabCloseHandler: TabCloseHandler | undefined;
let tabMoveHandler: ((id: string) => Promise<CloseResult>) | undefined;
let surfaceCloseHandler: ((targets: CloseTarget[], exit: boolean) => Promise<CloseResult>) | undefined;
export function installTabCloseHandler(handler: TabCloseHandler, move?: (id: string) => Promise<CloseResult>, surfaces?: (targets: CloseTarget[], exit: boolean) => Promise<CloseResult>): () => void {
  tabCloseHandler = handler;
  tabMoveHandler = move;
  surfaceCloseHandler = surfaces;
  return () => { if (tabCloseHandler === handler) { tabCloseHandler = undefined; tabMoveHandler = undefined; surfaceCloseHandler = undefined; } };
}
export function prepareSurfaceClose(targets: CloseTarget[], exit = false): Promise<CloseResult> {
  return surfaceCloseHandler ? surfaceCloseHandler(targets, exit) : Promise.resolve({ status: "failed", closed: [], failed: [{ id: "shell", error: "Close coordinator is unavailable" }] });
}
export function prepareTabMove(id: string): Promise<CloseResult> {
  return tabMoveHandler ? tabMoveHandler(id) : Promise.resolve({ status: "failed", closed: [], failed: [{ id, error: "The close coordinator is unavailable" }] });
}
export function routeTabClose(ids: string[]): boolean {
  if (!tabCloseHandler) return false;
  void tabCloseHandler(ids);
  return true;
}
export function requestTabClose(ids: string[], exit = false): Promise<CloseResult> {
  return tabCloseHandler ? tabCloseHandler(ids, exit) : Promise.resolve({ status: "failed", closed: [], failed: [{ id: "shell", error: "Close coordinator is unavailable" }] });
}
