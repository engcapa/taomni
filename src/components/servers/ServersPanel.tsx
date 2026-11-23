import { useCallback, useEffect, useRef, useState } from "react";
import {
  SERVER_ORDER,
  saveServerConfig,
  listenServerOutput,
  listenServerStatus,
  serverSettingsNeedVault,
  type ServerType,
} from "../../lib/servers";
import { useServersStore } from "../../stores/serversStore";
import { useT } from "../../lib/i18n";
import { confirmAppDialog } from "../../lib/appDialogs";
import { ensureVaultReady } from "../../lib/vaultGate";
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
 * Local servers manager tab panel.
 *
 * Subscribes to output + status events for every server type while mounted,
 * hydrates configs from the backend, and confirms discard on Cancel when dirty.
 */
export function ServersPanel({ onClose }: { onClose?: () => void }) {
  const t = useT();
  const appendLog = useServersStore((s) => s.appendLog);
  const loadAll = useServersStore((s) => s.loadAll);
  const [applying, setApplying] = useState(false);

  // Snapshot of the port each server was last saved with, so Apply can warn
  // when a running server's port changed (it won't take effect until restart).
  const appliedPorts = useRef<Partial<Record<ServerType, number>>>({});

  // Hydrate configs + live statuses when the window mounts.
  useEffect(() => {
    void loadAll();
  }, [loadAll]);

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
  }, []);

  const attemptClose = useCallback(async () => {
    if (applying) return;
    if (useServersStore.getState().editedServers.size > 0) {
      const confirmed = await confirmAppDialog({
        message: t("servers.confirmDiscard"),
      });
      if (!confirmed) return;
      await loadAll();
    }
    onClose?.();
  }, [applying, loadAll, onClose, t]);

  const handleApply = async () => {
    const { configs, editedServers, commitConfig } = useServersStore.getState();
    if (applying || editedServers.size === 0) return;
    setApplying(true);
    try {
      for (const type of SERVER_ORDER) {
        if (!editedServers.has(type)) continue;
        const submitted = configs[type];
        try {
          if (type === "rdp" && !(await ensureVaultReady(t("servers.notes.rdpVaultReason")))) {
            appendLog(type, timestampLine(t("servers.notes.rdpVaultCancelled")));
            continue;
          }
          if (serverSettingsNeedVault(type, submitted) &&
            !(await ensureVaultReady(t(type === "vnc" ? "servers.notes.vncVaultReason" : "servers.notes.localVaultReason")))) {
            continue;
          }
          const { configs: current, runtimes } = useServersStore.getState();
          if (current[type] !== submitted) continue;
          const saved = await saveServerConfig(type, submitted);
          commitConfig(type, submitted, saved);
          const prevPort = appliedPorts.current[type];
          if (runtimes[type]?.status === "running" && prevPort !== undefined && prevPort !== saved.port) {
            appendLog(type, timestampLine(t("servers.restartForPort")));
          }
          appliedPorts.current[type] = saved.port;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          appendLog(type, timestampLine(message));
        }
      }
    } finally {
      setApplying(false);
    }
  };

  return (
    <div
      role="region"
      aria-labelledby="servers-dialog-title"
      data-testid="servers-dialog"
      className="h-full min-h-0 w-full flex-1 flex flex-col overflow-hidden"
      style={{
        background: "var(--taomni-panel-bg)",
        color: "var(--taomni-text)",
      }}
    >
      {/* Visually quiet page header — OS window title carries the real name */}
      <div
        className="h-8 flex items-center px-3 shrink-0 border-b text-[12px] font-semibold"
        style={{
          background: "var(--taomni-quick-bg)",
          borderColor: "var(--taomni-divider)",
        }}
      >
        <span id="servers-dialog-title">{t("servers.dialogTitle")}</span>
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
          disabled={applying}
          className="taomni-btn"
          onClick={() => void attemptClose()}
        >
          {t("servers.cancel")}
        </button>
        <button
          type="button"
          data-testid="servers-dialog-apply"
          disabled={applying}
          className="taomni-btn"
          data-primary="true"
          onClick={() => void handleApply()}
        >
          {t("servers.apply")}
        </button>
      </div>
    </div>
  );
}
