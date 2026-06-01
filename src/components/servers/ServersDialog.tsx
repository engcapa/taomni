import { useEffect, useRef } from "react";
import { Server, X } from "lucide-react";
import {
  SERVER_ORDER,
  saveServerConfig,
  listenServerOutput,
  listenServerStatus,
  type ServerType,
} from "../../lib/servers";
import { useServersStore } from "../../stores/serversStore";
import { useT } from "../../lib/i18n";
import { ServerList } from "./ServerList";
import { ServerSettings } from "./ServerSettings";

function timestampLine(line: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
    now.getHours(),
  )}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return `[${stamp}] ${line}`;
}

/**
 * Modal shell for the local-servers manager. Mirrors the TunnelEditor chrome:
 * a gradient title bar, a two-pane body (server list + settings), and a
 * Cancel/Apply footer. Self-gates on the store's `isOpen` so callers can
 * render it unconditionally. While open it subscribes to output and status
 * events for all server types and tears the listeners down on close.
 */
export function ServersDialog() {
  const isOpen = useServersStore((s) => s.isOpen);
  if (!isOpen) return null;
  return <ServersDialogInner />;
}

function ServersDialogInner() {
  const t = useT();
  const closeDialog = useServersStore((s) => s.closeDialog);
  const appendLog = useServersStore((s) => s.appendLog);
  const clearDirty = useServersStore((s) => s.clearDirty);

  // Snapshot of the port each server was last saved with, so Apply can warn
  // when a running server's port changed (it won't take effect until restart).
  const appliedPorts = useRef<Partial<Record<ServerType, number>>>({});

  // Subscribe to output + status events for every server type while open.
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;

    for (const type of SERVER_ORDER) {
      void listenServerOutput(type, (line) => {
        useServersStore.getState().appendLog(type, line);
      }).then((un) => {
        if (cancelled) un();
        else unlisteners.push(un);
      });
      void listenServerStatus(type, (status) => {
        useServersStore.getState().setStatus(type, status);
      }).then((un) => {
        if (cancelled) un();
        else unlisteners.push(un);
      });
    }

    // Seed the applied-port snapshot from current configs.
    const configs = useServersStore.getState().configs;
    for (const type of SERVER_ORDER) {
      appliedPorts.current[type] = configs[type].port;
    }

    return () => {
      cancelled = true;
      for (const un of unlisteners) un();
    };
    // appendLog/setStatus are referenced via getState() so the listeners stay
    // stable; this effect should run exactly once per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const attemptClose = () => {
    if (useServersStore.getState().dirty) {
      if (!window.confirm(t("servers.confirmDiscard"))) return;
    }
    clearDirty();
    closeDialog();
  };

  // Escape closes (confirming when there are unsaved edits).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        attemptClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleApply = async () => {
    const { configs, runtimes } = useServersStore.getState();
    for (const type of SERVER_ORDER) {
      const cfg = configs[type];
      try {
        await saveServerConfig(type, cfg);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        appendLog(type, timestampLine(message));
        continue;
      }
      // Warn when a running server's port changed: the live process keeps the
      // old port until it is restarted.
      const prevPort = appliedPorts.current[type];
      if (
        runtimes[type]?.status === "running" &&
        prevPort !== undefined &&
        prevPort !== cfg.port
      ) {
        appendLog(type, timestampLine(t("servers.restartForPort")));
      }
      appliedPorts.current[type] = cfg.port;
    }
    clearDirty();
  };

  return (
    <div
      className="fixed inset-0 z-[400] flex items-center justify-center"
      style={{ background: "rgba(20,30,45,0.45)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) attemptClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="servers-dialog-title"
        data-testid="servers-dialog"
        className="flex flex-col rounded-[6px] shadow-2xl border overflow-hidden"
        style={{
          width: 720,
          height: 520,
          minWidth: 600,
          minHeight: 420,
          maxWidth: "96%",
          maxHeight: "92vh",
          background: "var(--taomni-panel-bg)",
          borderColor: "var(--taomni-chrome-border)",
          color: "var(--taomni-text)",
        }}
      >
        {/* Title bar */}
        <div
          className="h-7 flex items-center px-2 rounded-t-[5px] shrink-0"
          style={{ background: "linear-gradient(to bottom,#5895c8,#2b5d8b)", color: "white" }}
        >
          <Server className="w-3.5 h-3.5 mr-1.5" />
          <div id="servers-dialog-title" className="text-[12px] font-semibold">
            {t("servers.dialogTitle")}
          </div>
          <button
            type="button"
            data-testid="servers-dialog-close"
            title={t("servers.cancel")}
            aria-label={t("servers.cancel")}
            className="ml-auto hover:bg-red-500 rounded p-0.5"
            onClick={attemptClose}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 flex flex-row">
          <ServerList />
          <ServerSettings />
        </div>

        {/* Footer */}
        <div
          className="h-9 flex items-center justify-end gap-2 px-3 border-t shrink-0"
          style={{ background: "var(--taomni-quick-bg)", borderColor: "var(--taomni-divider)" }}
        >
          <button
            type="button"
            data-testid="servers-dialog-cancel"
            className="taomni-btn"
            onClick={attemptClose}
          >
            {t("servers.cancel")}
          </button>
          <button
            type="button"
            data-testid="servers-dialog-apply"
            className="taomni-btn"
            data-primary="true"
            onClick={() => void handleApply()}
          >
            {t("servers.apply")}
          </button>
        </div>
      </div>
    </div>
  );
}

