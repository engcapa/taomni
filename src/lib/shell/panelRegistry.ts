import type { ShellSurfaceAdapter } from "./types";

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
/** One production registry for all SFTP/workspace surface commands. */
export class PanelRegistry {
  private entries = new Map<string, ShellSurfaceAdapter>();
  register(adapter: ShellSurfaceAdapter): () => void {
    this.entries.set(adapter.id, adapter);
    return () => { if (this.entries.get(adapter.id) === adapter) this.entries.delete(adapter.id); };
  }
  get(id: string) { return this.entries.get(id); }
  list() { return [...this.entries.values()]; }
}
export const shellPanelRegistry = new PanelRegistry();
