import { AlertCircle, LogOut, Network as NetworkIcon, Play, Plus, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { confirmAppDialog } from "../../lib/appDialogs";
import { useT } from "../../lib/i18n";
import { isTauriRuntime } from "../../lib/runtime";
import {
  deleteTunnel,
  listenTunnelStatus,
  listTunnels,
  listTunnelStatuses,
  newTunnelId,
  reorderTunnels,
  startAllTunnels,
  startTunnel,
  stopAllTunnels,
  stopTunnel,
  testTunnel,
  upsertTunnel,
  type TunnelConfig,
  type TunnelStatusInfo,
} from "../../lib/tunnel";
import { useSessionStore } from "../../stores/sessionStore";
import { ActivityLog } from "./manager/log";
import { type Props, type TunnelLogEntry, type TunnelLogLevel } from "./manager/model";
import { Th, TunnelRow } from "./manager/row";
import { TunnelEditor } from "./TunnelEditor";

export function TunnelManager({ onStatusMessage, onClose }: Props) {
  const t = useT();
  const { sessions, loadSessions } = useSessionStore();
  const [tunnels, setTunnels] = useState<TunnelConfig[]>([]);
  const [statuses, setStatuses] = useState<Record<string, TunnelStatusInfo>>({});
  const [editing, setEditing] = useState<TunnelConfig | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [editorFocus, setEditorFocus] = useState<"auth" | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  /**
   * Rolling activity log — every test/start/stop result lands here so the
   * user can read the full message even after the bottom status bar has
   * cleared. Errors auto-expand the panel; successes leave it closed.
   */
  const [logs, setLogs] = useState<TunnelLogEntry[]>([]);
  const [logExpanded, setLogExpanded] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  const appendLog = useCallback((level: TunnelLogLevel, text: string) => {
    setLogs((prev) => {
      const next = prev.concat({ id: `log-${Date.now()}-${prev.length}`, level, text, ts: Date.now() });
      // Cap history so a long-running session can't grow without bound.
      return next.length > 200 ? next.slice(next.length - 200) : next;
    });
    if (level === "error") setLogExpanded(true);
  }, []);

  // Mirror every status-bar message into the log panel so the user has a
  // single place to review what happened, even for ephemeral toasts.
  const reportStatus = useCallback(
    (msg: string, level: TunnelLogLevel = "info") => {
      onStatusMessage?.(msg);
      appendLog(level, msg);
    },
    [onStatusMessage, appendLog],
  );

  const setStatus = useCallback((info: TunnelStatusInfo) => {
    setStatuses((prev) => ({ ...prev, [info.id]: info }));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [list, st] = await Promise.all([listTunnels(), listTunnelStatuses()]);
      setTunnels(list.slice().sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)));
      const map: Record<string, TunnelStatusInfo> = {};
      for (const s of st) map[s.id] = s;
      setStatuses(map);
    } catch (err) {
      reportStatus(
        t("tunnels.loadFailed", { error: err instanceof Error ? err.message : String(err) }),
        "error",
      );
    } finally {
      setLoading(false);
    }
  }, [reportStatus, t]);

  useEffect(() => {
    void loadSessions();
    void refresh();
  }, [loadSessions, refresh]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenTunnelStatus((info) => {
      setStatus(info);
      // Background errors (e.g. an SSH handshake that fails after the
      // command returned "starting") only land on this event — surface
      // them in the log so the user can read the cause without watching
      // the bottom status bar.
      if (info.status === "error" && info.error) {
        const errMsg = info.error;
        setTunnels((current) => {
          const tunnel = current.find((tt) => tt.id === info.id);
          appendLog(
            "error",
            t("tunnels.tunnelFailed", {
              name: tunnel?.name ?? info.id,
              error: errMsg,
            }),
          );
          return current;
        });
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [setStatus, appendLog, t]);

  const handleNew = () => {
    setEditing(null);
    setEditorFocus(undefined);
    setShowEditor(true);
  };

  const handleEdit = (t: TunnelConfig) => {
    setEditing(t);
    setEditorFocus(undefined);
    setShowEditor(true);
  };

  const handleEditKey = (t: TunnelConfig) => {
    setEditing(t);
    setEditorFocus("auth");
    setShowEditor(true);
  };

  const handleTest = async (t2: TunnelConfig) => {
    reportStatus(t("tunnels.testing", { name: t2.name }));
    try {
      const msg = await testTunnel(t2.id);
      reportStatus(msg, "success");
    } catch (err) {
      reportStatus(
        t("tunnels.testFailed", { name: t2.name, error: err instanceof Error ? err.message : String(err) }),
        "error",
      );
    }
  };

  const handleClone = async (t2: TunnelConfig) => {
    const copy: TunnelConfig = {
      ...t2,
      id: newTunnelId(),
      name: `${t2.name} (copy)`,
      sortOrder: tunnels.length,
    };
    try {
      await upsertTunnel(copy);
      await refresh();
      reportStatus(t("tunnels.cloned", { name: copy.name }));
    } catch (err) {
      reportStatus(
        t("tunnels.cloneFailed", { error: err instanceof Error ? err.message : String(err) }),
        "error",
      );
    }
  };

  const handleDelete = async (t2: TunnelConfig) => {
    const confirmed = await confirmAppDialog({
      message: t("tunnels.confirmDeleteName", { name: t2.name }),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await deleteTunnel(t2.id);
      await refresh();
      reportStatus(t("tunnels.deleted", { name: t2.name }));
    } catch (err) {
      reportStatus(
        t("tunnels.deleteFailed", { error: err instanceof Error ? err.message : String(err) }),
        "error",
      );
    }
  };

  const handleStart = async (t2: TunnelConfig) => {
    setStatus({ id: t2.id, status: "starting" });
    try {
      const info = await startTunnel(t2.id);
      setStatus(info);
      if (info.status === "error") {
        reportStatus(
          t("tunnels.tunnelFailed", { name: t2.name, error: info.error ?? t("tunnels.unknownError") }),
          "error",
        );
      } else if (info.status === "running") {
        reportStatus(
          t("tunnels.tunnelRunningOn", { name: t2.name, endpoint: `${t2.listenHost}:${t2.listenPort}` }),
          "success",
        );
      } else {
        // "starting" — final outcome will arrive on the tunnel-status event.
        reportStatus(t("tunnels.tunnelStarting", { name: t2.name }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus({ id: t2.id, status: "error", error: msg });
      reportStatus(t("tunnels.tunnelFailed", { name: t2.name, error: msg }), "error");
    }
  };

  const handleStop = async (t2: TunnelConfig) => {
    try {
      const info = await stopTunnel(t2.id);
      setStatus(info);
    } catch (err) {
      reportStatus(
        t("tunnels.stopFailed", { error: err instanceof Error ? err.message : String(err) }),
        "error",
      );
    }
  };

  const handleStartAll = async () => {
    setBusy(true);
    try {
      const list = await startAllTunnels();
      const map = { ...statuses };
      for (const s of list) map[s.id] = s;
      setStatuses(map);
      const failed = list.filter((s) => s.status === "error").length;
      // Surface every per-tunnel error to the log so the user can see what
      // broke even if the bottom status bar only shows the aggregate count.
      for (const info of list) {
        if (info.status === "error" && info.error) {
          const tunnel = tunnels.find((tt) => tt.id === info.id);
          appendLog(
            "error",
            t("tunnels.tunnelFailed", {
              name: tunnel?.name ?? info.id,
              error: info.error,
            }),
          );
        }
      }
      reportStatus(
        failed > 0 ? t("tunnels.startedAllWithErrors", { errors: failed }) : t("tunnels.startedAll"),
        failed > 0 ? "error" : "success",
      );
    } catch (err) {
      reportStatus(
        t("tunnels.startAllFailed", { error: err instanceof Error ? err.message : String(err) }),
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleStopAll = async () => {
    setBusy(true);
    try {
      const list = await stopAllTunnels();
      const map = { ...statuses };
      for (const s of list) map[s.id] = s;
      setStatuses(map);
      reportStatus(t("tunnels.stoppedAll"));
    } catch (err) {
      reportStatus(
        t("tunnels.stopAllFailed", { error: err instanceof Error ? err.message : String(err) }),
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleSaveDraft = async (config: TunnelConfig) => {
    const next: TunnelConfig = {
      ...config,
      sortOrder: config.sortOrder ?? tunnels.length,
    };
    await upsertTunnel(next);
    await refresh();
    setShowEditor(false);
    setEditing(null);
    reportStatus(t("tunnels.savedNamed", { name: next.name }));
  };

  const reorder = async (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= tunnels.length || to >= tunnels.length) return;
    const next = tunnels.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setTunnels(next);
    try {
      await reorderTunnels(next.map((tt) => tt.id));
    } catch (err) {
      reportStatus(
        t("tunnels.reorderFailed", { error: err instanceof Error ? err.message : String(err) }),
        "error",
      );
      void refresh();
    }
  };

  const tauri = isTauriRuntime();

  return (
    <div
      data-testid="tunnel-manager"
      className="w-full h-full flex flex-col"
      style={{ background: "var(--taomni-bg)", color: "var(--taomni-text)" }}
    >
      {/* Header */}
      <div
        className="px-4 py-2 border-b shrink-0 flex items-center gap-2"
        style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
      >
        <NetworkIcon className="w-4 h-4" style={{ color: "var(--taomni-accent)" }} />
        <div className="text-[13px] font-semibold" style={{ color: "var(--taomni-accent)" }}>
          {t("tunnels.headerTitle")}
        </div>
        <div className="text-[11px] ml-2" style={{ color: "var(--taomni-text-muted)" }}>
          {t("tunnels.headerSubtitle")}
        </div>
      </div>

      {!tauri && (
        <div
          className="px-4 py-1.5 text-[11px] border-b shrink-0 flex items-center gap-1.5"
          style={{
            background: "rgba(255,196,0,0.12)",
            borderColor: "var(--taomni-divider)",
            color: "var(--taomni-text-muted)",
          }}
        >
          <AlertCircle className="w-3 h-3" />
          {t("tunnels.previewWarning")}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 min-h-0 overflow-auto px-3 py-3">
        <div
          className="rounded border overflow-hidden"
          style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-panel-bg)" }}
        >
          <table data-testid="tunnel-list" className="w-full text-[12px] border-collapse">
            <thead>
              <tr style={{ background: "var(--taomni-quick-bg)", color: "var(--taomni-text)" }}>
                <Th>{t("tunnels.thOrder")}</Th>
                <Th className="text-left">{t("tunnels.thName")}</Th>
                <Th>{t("tunnels.thType")}</Th>
                <Th>{t("tunnels.thStatus")}</Th>
                <Th>{t("tunnels.thForwardPort")}</Th>
                <Th className="text-left">{t("tunnels.thDestination")}</Th>
                <Th className="text-left">{t("tunnels.thSshServer")}</Th>
                <Th>{t("tunnels.thSettings")}</Th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={8} className="text-center py-6" style={{ color: "var(--taomni-text-muted)" }}>
                    {t("tunnels.loadingList")}
                  </td>
                </tr>
              )}
              {!loading && tunnels.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center py-8" style={{ color: "var(--taomni-text-muted)" }}>
                    {t("tunnels.emptyHint")} <strong>{t("tunnels.emptyHintAction")}</strong> {t("tunnels.emptyHintSuffix")}
                  </td>
                </tr>
              )}
              {!loading &&
                tunnels.map((tt, idx) => (
                  <TunnelRow
                    key={tt.id}
                    tunnel={tt}
                    index={idx}
                    total={tunnels.length}
                    status={statuses[tt.id]}
                    onStart={() => handleStart(tt)}
                    onStop={() => handleStop(tt)}
                    onEdit={() => handleEdit(tt)}
                    onEditKey={() => handleEditKey(tt)}
                    onTest={() => handleTest(tt)}
                    onClone={() => handleClone(tt)}
                    onDelete={() => handleDelete(tt)}
                    onMoveUp={() => reorder(idx, idx - 1)}
                    onMoveDown={() => reorder(idx, idx + 1)}
                    onToggleAutostart={async () => {
                      try {
                        await upsertTunnel({ ...tt, autostart: !tt.autostart });
                        await refresh();
                      } catch (err) {
                        reportStatus(
                          t("tunnels.toggleFailed", { error: err instanceof Error ? err.message : String(err) }),
                          "error",
                        );
                      }
                    }}
                  />
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Activity / error log */}
      <ActivityLog
        logs={logs}
        expanded={logExpanded}
        onToggle={() => setLogExpanded((v) => !v)}
        onClear={() => setLogs([])}
        listRef={logRef}
      />

      {/* Footer */}
      <div
        className="h-12 flex items-center px-3 gap-2 border-t shrink-0"
        style={{ background: "var(--taomni-quick-bg)", borderColor: "var(--taomni-divider)" }}
      >
        <button data-testid="tunnel-new" type="button" className="taomni-btn flex items-center gap-1.5" onClick={handleNew}>
          <Plus className="w-3.5 h-3.5" /> {t("tunnels.newSshTunnel")}
        </button>
        <button
          data-testid="tunnel-start-all"
          type="button"
          className="taomni-btn flex items-center gap-1.5"
          onClick={handleStartAll}
          disabled={busy || tunnels.length === 0}
        >
          <Play className="w-3.5 h-3.5" style={{ color: "#1f7a4a" }} /> {t("tunnels.startAllTunnels")}
        </button>
        <button
          data-testid="tunnel-stop-all"
          type="button"
          className="taomni-btn flex items-center gap-1.5"
          onClick={handleStopAll}
          disabled={busy || tunnels.length === 0}
        >
          <Square className="w-3.5 h-3.5" style={{ color: "#b22222" }} /> {t("tunnels.stopAllTunnels")}
        </button>
        {onClose && (
          <button
            data-testid="tunnel-exit"
            type="button"
            className="taomni-btn flex items-center gap-1.5"
            onClick={onClose}
            title={t("tunnels.exitTitle")}
          >
            <LogOut className="w-3.5 h-3.5" /> {t("tunnels.exit")}
          </button>
        )}
        <div className="flex-1" />
        <span className="text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
          {t("tunnels.countSummary", {
            count: tunnels.length,
            plural: tunnels.length === 1 ? "" : "s",
            running: Object.values(statuses).filter((s) => s.status === "running").length,
          })}
        </span>
      </div>

      {showEditor && (
        <TunnelEditor
          initial={editing ?? undefined}
          sessions={sessions}
          focus={editorFocus}
          onSave={handleSaveDraft}
          onCancel={() => {
            setShowEditor(false);
            setEditing(null);
            setEditorFocus(undefined);
          }}
        />
      )}
    </div>
  );
}

// Re-export so other modules don't have to think about the manager file
export { defaultTunnel } from "../../lib/tunnel";
