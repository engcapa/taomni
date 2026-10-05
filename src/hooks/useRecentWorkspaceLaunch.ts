import { useRef, useState } from "react";
import { workspaceListDir } from "../lib/editor/workspace";
import { selectFolderPath } from "../lib/ipc";
import type { RecentWorkspace } from "../types";

export interface RecentWorkspaceLaunch { state: "opening" | "ready" | "failed"; error?: string; rootPath?: string }
export function useRecentWorkspaceLaunch(
  openReady: (workspace: RecentWorkspace) => Promise<void>,
  replace: (workspace: RecentWorkspace) => void,
  activateExisting?: (workspace: RecentWorkspace) => boolean,
) {
  const [launches, setLaunches] = useState<Record<string, RecentWorkspaceLaunch>>({});
  const pending = useRef(new Map<string, Promise<void>>());
  const picking = useRef(new Set<string>());
  const latest = useRef({ openReady, replace, activateExisting }); latest.current = { openReady, replace, activateExisting };
  const open = (workspace: RecentWorkspace): Promise<void> => {
    if (picking.current.has(workspace.id)) return Promise.resolve();
    const existing = pending.current.get(workspace.id); if (existing) return existing;
    // An already mounted editor owns its readiness and unsaved buffers. Do not
    // wait for another filesystem preflight simply to bring it to the front.
    if (latest.current.activateExisting?.(workspace)) {
      setLaunches((s) => ({ ...s, [workspace.id]: { state: "ready" } }));
      return Promise.resolve();
    }
    setLaunches((s) => ({ ...s, [workspace.id]: { state: "opening" } }));
    let rootPath: string | undefined;
    const run = (async () => {
      try {
        for (const root of workspace.roots) {
          rootPath = root.path;
          const result = await workspaceListDir(root.path);
          if (result.state !== "ready") throw new Error(result.state === "failed" ? result.message : result.state === "unavailable" ? result.reason : "Workspace opening cancelled");
        }
        await latest.current.openReady(workspace);
        setLaunches((s) => ({ ...s, [workspace.id]: { state: "ready" } }));
      } catch (error) {
        setLaunches((s) => ({ ...s, [workspace.id]: { state: "failed", error: String(error), rootPath } }));
      } finally { pending.current.delete(workspace.id); }
    })();
    pending.current.set(workspace.id, run);
    return run;
  };
  const relocate = async (workspace: RecentWorkspace) => {
    if (pending.current.has(workspace.id) || picking.current.has(workspace.id)) return;
    const oldPath = launches[workspace.id]?.rootPath ?? workspace.roots[0]?.path;
    if (!oldPath) return;
    picking.current.add(workspace.id);
    try {
      const path = await selectFolderPath();
      if (!path) return;
      const result = await workspaceListDir(path);
      if (result.state !== "ready") throw new Error(result.state === "failed" ? result.message : result.state === "unavailable" ? result.reason : "Workspace opening cancelled");
      const updated = { ...workspace, roots: workspace.roots.map((root) => root.path === oldPath ? { ...root, path } : root) };
      latest.current.replace(updated);
      picking.current.delete(workspace.id);
      await open(updated);
    } catch (error) { setLaunches((s) => ({ ...s, [workspace.id]: { state: "failed", error: String(error), rootPath: oldPath } })); }
    finally { picking.current.delete(workspace.id); }
  };
  return { launches, open, relocate };
}
