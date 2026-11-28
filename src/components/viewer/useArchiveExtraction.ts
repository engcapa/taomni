import { useEffect, useRef, useState } from "react";
import { archiveExtraction, archiveExtractionActive, type ArchiveExtraction } from "../../lib/openFile/archive";

type Action = "start" | "cancel" | "resume" | "discard";
type Result = ArchiveExtraction | null;

export function useArchiveExtraction(path: string, active: boolean) {
  const [load, setLoad] = useState<{ path: string; job: Result }>();
  const [actionError, setActionError] = useState<{ path: string; reason: string }>();
  const [pollError, setPollError] = useState<{ path: string; reason: string }>();
  const [pending, setPending] = useState<{ path: string; action: Action }>();
  const epoch = useRef(0);
  const request = useRef<Action | undefined>(undefined);

  useEffect(() => {
    if (!active) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    const update = async () => {
      const version = epoch.current;
      let running = false;
      if (!request.current) {
        try {
          const job = await archiveExtraction.status(path);
          running = job !== null && archiveExtractionActive(job.phase);
          if (current && version === epoch.current) {
            setLoad({ path, job });
            setPollError(undefined);
          }
        } catch (reason) {
          if (current && version === epoch.current) setPollError({ path, reason: String(reason) });
        }
      }
      if (current) timer = setTimeout(() => { void update(); }, running || request.current ? 100 : 500);
    };
    void update();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [active, path]);

  useEffect(() => () => {
    epoch.current++;
    request.current = undefined;
  }, [path]);

  async function run(action: Action, operation: () => Promise<Result>) {
    if (request.current) return;
    request.current = action;
    const version = ++epoch.current;
    setPending({ path, action });
    setActionError(undefined);
    try {
      const job = await operation();
      if (version === epoch.current) {
        setLoad({ path, job });
        setPollError(undefined);
      }
    } catch (reason) {
      if (version === epoch.current) setActionError({ path, reason: String(reason) });
    } finally {
      if (version === epoch.current) {
        request.current = undefined;
        setPending(undefined);
      }
    }
  }

  return {
    ready: load?.path === path,
    job: load?.path === path ? load.job : null,
    error: actionError?.path === path ? actionError.reason : pollError?.path === path ? pollError.reason : "",
    pending: pending?.path === path ? pending.action : undefined,
    run,
  };
}
