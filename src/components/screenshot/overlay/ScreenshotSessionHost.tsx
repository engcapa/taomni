import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState, type ReactNode } from "react";
import { beginOverlaySession } from "./startupTiming";
import { discardOverlayPrefetch } from "./prefetch";
import { ScreenshotSessionGeneration } from "./sessionGeneration";

interface Session {
  generation: number | null;
  active: boolean;
}
interface SessionEvent {
  generation: number;
  active: boolean;
}

export function nextScreenshotSession(current: Session | null, event: SessionEvent): Session | null {
  if (!Number.isSafeInteger(event.generation) || event.generation < 0) return current;
  if (current?.generation !== null && current?.generation !== undefined) {
    if (event.generation < current.generation) return current;
    if (event.generation === current.generation && event.active === current.active) return current;
    // Once retired, an equal generation can never become active again.
    if (event.generation === current.generation && !current.active && event.active) return current;
  }
  return event;
}

/**
 * Only the native dedicated root owns a resident session. Register the window
 * listener before mounting the initial overlay/ready signal. An idle renderer
 * renders nothing: the keyed child owns every image URL, async callback, timer,
 * selection, annotation history and event effect for exactly one generation.
 */
export function ScreenshotSessionHost({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    let latest: Session | null = null;
    void getCurrentWindow().listen<SessionEvent>("screenshot://session", ({ payload }) => {
      if (disposed) return;
      const next = nextScreenshotSession(latest, payload);
      if (next === latest) return;
      if (next?.active) beginOverlaySession();
      else discardOverlayPrefetch();
      latest = next;
      setSession(next);
    }).then(async (unlisten) => {
      if (disposed) { unlisten(); return; }
      stop = unlisten;
      // Snapshot only after subscribing: prewarm can race the first trigger.
      // A newer event always takes precedence over this in-flight result.
      const snapshot = await invoke<SessionEvent | null>("screenshot_overlay_session");
      if (disposed || latest) return;
      latest = snapshot ?? { generation: null, active: false };
      if (!latest.active) discardOverlayPrefetch();
      setSession(latest);
    }).catch((error: unknown) => {
      // Do not allow a failed listener to pretend it can safely retain state.
      console.error("[screenshot] session listener failed", error);
    });
    return () => { disposed = true; stop?.(); };
  }, []);
  return session?.active ? <ScreenshotSessionGeneration.Provider key={session.generation ?? "initial"} value={session.generation ?? undefined}>
    <div>{children}</div>
  </ScreenshotSessionGeneration.Provider> : null;
}
