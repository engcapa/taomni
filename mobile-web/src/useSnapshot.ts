import { useCallback, useEffect, useRef, useState } from "react";
import { errorText, request, type Instance } from "./api";

interface Snapshot<T> { value: T | null; updated: string; loading: boolean; error: string; key?: string }
const empty = <T,>(): Snapshot<T> => ({ value: null, updated: "", loading: false, error: "" });

/** Retain only successful data for this exact resource, never another path's data. */
export function useSnapshot<T>(instance: Instance, path: string | null, revision: number) {
  const [snapshot, setSnapshot] = useState<Snapshot<T>>(empty);
  const owner = useRef<{ controller: AbortController; key: string } | null>(null);
  const key = JSON.stringify([instance.id, instance.endpoint, instance.token, path]);
  const refresh = useCallback(async () => {
    owner.current?.controller.abort();
    const current = { controller: new AbortController(), key };
    owner.current = current;
    if (!path) { setSnapshot(empty()); return; }
    setSnapshot(v => ({ ...(v.key === key ? v : empty<T>()), key, loading: true, error: "" }));
    try {
      const value = await request<T>(instance, path, undefined, current.controller.signal);
      if (owner.current !== current || current.controller.signal.aborted) return;
      setSnapshot({ key, value, updated: new Date().toLocaleTimeString(), loading: false, error: "" });
    } catch (error) {
      if (owner.current !== current || current.controller.signal.aborted) return;
      setSnapshot(v => ({ ...v, loading: false, error: errorText(error) }));
    }
  }, [instance, path, key]);
  useEffect(() => {
    void refresh();
    return () => { owner.current?.controller.abort(); };
  }, [refresh, revision]);
  return { ...(snapshot.key === key ? snapshot : empty<T>()), refresh };
}

export function freshness(updated: string, stale: boolean, loading: boolean) {
  return `上次更新 ${updated || "—"}${updated && stale ? " · 可能已过期" : ""}${loading ? " · 正在更新…" : ""}`;
}
