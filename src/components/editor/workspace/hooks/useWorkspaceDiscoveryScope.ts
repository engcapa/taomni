import { useEffect, useState } from "react";
import { getHomeDir } from "../../../../lib/ipc";
import { fsPathComparisonKey } from "../codeWorkspaceModel";

/** HOME remains an explorer even after opening a source file. Explicit project
 * refresh still uses the descriptor owner's recursive discovery entry. */
export function useWorkspaceDiscoveryScope(rootPath: string, hasSourceBuffers: boolean): "root" | "recursive" {
  const [home, setHome] = useState<{ resolved: boolean; path: string | null }>({ resolved: false, path: null });
  useEffect(() => {
    if (!rootPath) return;
    let cancelled = false;
    void (async () => {
      let path: string | null = null;
      try { path = await getHomeDir(); } catch { /* Retain ordinary project discovery if HOME is unavailable. */ }
      if (!cancelled) setHome({ resolved: true, path });
    })();
    return () => { cancelled = true; };
  }, [rootPath]);
  if (!hasSourceBuffers || !home.resolved) return "root";
  return home.path && fsPathComparisonKey(home.path) === fsPathComparisonKey(rootPath) ? "root" : "recursive";
}
