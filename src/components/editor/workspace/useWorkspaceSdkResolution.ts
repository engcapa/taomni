import { useCallback, useEffect, useRef, useState } from "react";
import {
  sdkGetRegistry,
  sdkResolveWorkspace,
  subscribeSdkRegistryChanged,
  type SdkRegistry,
  type WorkspaceSdkResolution,
} from "../../../lib/editor/sdk";
import type { CodeWorkspaceRootInfo } from "../../../types";

export interface RootSdkState {
  root: CodeWorkspaceRootInfo;
  resolution: WorkspaceSdkResolution | null;
  error: string | null;
}

const EMPTY_REGISTRY: SdkRegistry = { schemaVersion: 1, installations: [], defaults: [], bindings: [] };

/** Resolve only for source demand or an explicit SDK dialog; reject late results. */
export function useWorkspaceSdkResolution(roots: CodeWorkspaceRootInfo[], enabled: boolean) {
  const rootsKey = JSON.stringify(roots.map(({ id, path, name, kind }) => ({ id, path, name, kind })));
  const rootsRef = useRef(roots);
  rootsRef.current = roots;
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [registry, setRegistry] = useState(EMPTY_REGISTRY);
  const [rootStates, setRootStates] = useState<RootSdkState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    const requestedRoots = rootsRef.current;
    setLoading(true);
    try {
      const nextRegistry = await sdkGetRegistry();
      if (requestRef.current !== request) return;
      const nextRootStates = await Promise.all(requestedRoots.map(async (root): Promise<RootSdkState> => {
        try {
          return { root, resolution: await sdkResolveWorkspace(root.path), error: null };
        } catch (reason) {
          return { root, resolution: null, error: reason instanceof Error ? reason.message : String(reason) };
        }
      }));
      if (requestRef.current !== request) return;
      setRegistry(nextRegistry);
      setRootStates(nextRootStates);
      setError(null);
    } catch (reason) {
      if (requestRef.current !== request) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setRootStates(requestedRoots.map((root) => ({ root, resolution: null, error: null })));
    } finally {
      if (requestRef.current === request) {
        setLoading(false);
        setLoaded(true);
      }
    }
  }, [rootsKey]);

  useEffect(() => {
    setLoaded(false);
    setRootStates([]);
    setError(null);
  }, [rootsKey]);

  useEffect(() => {
    if (enabled) void load();
    else setLoading(false);
    const unsubscribe = subscribeSdkRegistryChanged(() => {
      if (enabled) void load();
    });
    return () => {
      requestRef.current += 1;
      unsubscribe();
    };
  }, [enabled, load]);

  return { loading, loaded, registry, rootStates, error, setError, load };
}
