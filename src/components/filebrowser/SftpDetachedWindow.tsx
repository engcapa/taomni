import { useEffect, useMemo, useState } from "react";
import { FileBrowser } from "./FileBrowser";
import { useAppTheme } from "../../lib/appTheme";

interface DetachedSftpParams {
  sessionId: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  authData: string | null;
  initialPath?: string;
  title?: string;
}

const STORAGE_PREFIX = "newmob.sftp.detached.";

export function readDetachedHandoff(sessionId: string): DetachedSftpParams | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_PREFIX + sessionId);
    if (!raw) return null;
    return JSON.parse(raw) as DetachedSftpParams;
  } catch {
    return null;
  }
}

export function writeDetachedHandoff(params: DetachedSftpParams): void {
  try {
    sessionStorage.setItem(STORAGE_PREFIX + params.sessionId, JSON.stringify(params));
  } catch {
    /* noop */
  }
}

export function detachedWindowUrl(sessionId: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set("sftp", sessionId);
  url.hash = "";
  return url.toString();
}

/**
 * Returns the SFTP session id requested via `?sftp=...` if the page was
 * opened as a detached SFTP window, or null otherwise.
 */
export function detectDetachedSftpRoute(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get("sftp");
  } catch {
    return null;
  }
}

export function SftpDetachedWindow({ sessionId }: { sessionId: string }) {
  const { mode, resolvedTheme } = useAppTheme();
  const [params, setParams] = useState<DetachedSftpParams | null>(() =>
    readDetachedHandoff(sessionId),
  );

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.appTheme = resolvedTheme;
    root.dataset.appThemeMode = mode;
    root.style.colorScheme = resolvedTheme;
  }, [mode, resolvedTheme]);

  useEffect(() => {
    if (params) return;
    const handler = (event: StorageEvent) => {
      if (event.key === STORAGE_PREFIX + sessionId && event.newValue) {
        try {
          setParams(JSON.parse(event.newValue) as DetachedSftpParams);
        } catch {
          /* ignore */
        }
      }
    };
    window.addEventListener("storage", handler);
    // poll sessionStorage too because storage event doesn't fire
    // for the same tab and sessionStorage isn't shared across tabs.
    const id = window.setInterval(() => {
      const next = readDetachedHandoff(sessionId);
      if (next) {
        setParams(next);
        window.clearInterval(id);
      }
    }, 250);
    return () => {
      window.removeEventListener("storage", handler);
      window.clearInterval(id);
    };
  }, [sessionId, params]);

  const title = useMemo(
    () => `${params?.title ?? `SFTP ${sessionId}`}`,
    [params?.title, sessionId],
  );

  useEffect(() => {
    document.title = `${title} • newmob`;
  }, [title]);

  if (!params) {
    return (
      <div
        className="w-screen h-screen flex items-center justify-center text-sm"
        style={{ background: "var(--moba-bg)", color: "var(--moba-text)" }}
      >
        Waiting for connection details from the parent window…
      </div>
    );
  }

  return (
    <div
      className="w-screen h-screen flex flex-col"
      style={{ background: "var(--moba-chrome-bg)", color: "var(--moba-text)" }}
    >
      <div
        className="h-6 px-2 flex items-center text-[11px] font-semibold border-b shrink-0"
        style={{ borderColor: "var(--moba-divider)", background: "var(--moba-quick-bg)" }}
      >
        <span className="truncate">{title}</span>
      </div>
      <div className="flex-1 min-h-0">
        <FileBrowser
          sessionId={params.sessionId}
          host={params.host}
          port={params.port}
          username={params.username}
          authMethod={params.authMethod}
          authData={params.authData}
          initialPath={params.initialPath}
          detachable={false}
        />
      </div>
    </div>
  );
}
