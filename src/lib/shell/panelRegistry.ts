import type { PanelInstance, PanelPlacement, ShellSurfaceAdapter } from "./types";

/** Resource groups live independently of tab visibility. Each job owns a separate lease. */
export class ResourceLeases {
  private groups = new Map<string, Map<string, "view" | "job">>();
  acquire(resourceKey: string, leaseId: string, kind: "view" | "job"): () => void {
    const group = this.groups.get(resourceKey) ?? new Map();
    group.set(leaseId, kind); this.groups.set(resourceKey, group);
    let released = false;
    return () => { if (released) return; released = true; group.delete(leaseId); if (!group.size) this.groups.delete(resourceKey); };
  }
  jobs(resourceKey: string): string[] { return [...(this.groups.get(resourceKey)?.entries() ?? [])].filter(([, kind]) => kind === "job").map(([id]) => id); }
  retained(resourceKey: string): boolean { return !!this.groups.get(resourceKey)?.size; }
}
export const shellResourceLeases = new ResourceLeases();
export class PanelRegistry {
  private entries = new Map<string, { instance: PanelInstance; adapter: ShellSurfaceAdapter }>();
  private pending = new Map<string, Promise<void>>();
  register(instance: PanelInstance, adapter: ShellSurfaceAdapter): () => void {
    const existing = this.entries.get(instance.id);
    if (existing && existing.adapter !== adapter) throw new Error(`Duplicate surface: ${instance.id}`);
    const entry = { instance, adapter }; this.entries.set(instance.id, entry);
    return () => { if (this.entries.get(instance.id) === entry) this.entries.delete(instance.id); };
  }
  get(id: string) { return this.entries.get(id); }
  move(id: string, destination: PanelPlacement): Promise<void> {
    const pending = this.pending.get(id); if (pending) return pending;
    const entry = this.entries.get(id); if (!entry) return Promise.reject(new Error("Missing panel"));
    const generation = entry.instance.generation;
    const operationId = crypto.randomUUID();
    const operation = (async () => {
      const ticket = await entry.adapter.prepareMove(destination, operationId);
      try {
        if (!ticket.ready || ticket.generation !== generation || this.entries.get(id) !== entry || entry.instance.generation !== generation)
          throw new Error("The panel owner changed while moving");
        await entry.adapter.commitMove(ticket);
      } catch (error) { await entry.adapter.rollbackMove(ticket); throw error; }
    })();
    this.pending.set(id, operation);
    void operation.finally(() => { if (this.pending.get(id) === operation) this.pending.delete(id); }).catch(() => undefined);
    return operation;
  }
}
export const shellPanelRegistry = new PanelRegistry();
