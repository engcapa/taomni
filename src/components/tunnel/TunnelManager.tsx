import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  Play,
  Square,
  Pencil,
  Copy,
  Trash2,
  Zap,
  Power,
  Network as NetworkIcon,
  GripVertical,
  AlertCircle,
  Loader2,
  CheckCircle2,
  CircleDot,
  Key as KeyIcon,
  Activity,
  LogOut,
  ChevronDown,
  ChevronUp,
  Trash,
} from "lucide-react";
import {
  defaultTunnel,
  deleteTunnel,
  listTunnels,
  listTunnelStatuses,
  listenTunnelStatus,
  newTunnelId,
  reorderTunnels,
  startAllTunnels,
  startTunnel,
  stopAllTunnels,
  stopTunnel,
  testTunnel,
  upsertTunnel,
  type TunnelAuthStatus,
  type TunnelConfig,
  type TunnelStatus,
  type TunnelStatusInfo,
} from "../../lib/tunnel";
import { TunnelEditor } from "./TunnelEditor";
import { useSessionStore } from "../../stores/sessionStore";
import { isTauriRuntime } from "../../lib/runtime";
import { useT } from "../../lib/i18n";

interface Props {
  onStatusMessage?: (msg: string) => void;
  onClose?: () => void;
}

type TunnelLogLevel = "info" | "success" | "error";

interface TunnelLogEntry {
  id: string;
  level: TunnelLogLevel;
  text: string;
  /** Wall-clock ms; rendered as HH:MM:SS in the panel. */
  ts: number;
}

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
    if (!window.confirm(t("tunnels.confirmDeleteName", { name: t2.name }))) return;
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
      style={{ background: "var(--moba-bg)", color: "var(--moba-text)" }}
    >
      {/* Header */}
      <div
        className="px-4 py-2 border-b shrink-0 flex items-center gap-2"
        style={{ borderColor: "var(--moba-divider)", background: "var(--moba-quick-bg)" }}
      >
        <NetworkIcon className="w-4 h-4" style={{ color: "var(--moba-accent)" }} />
        <div className="text-[13px] font-semibold" style={{ color: "var(--moba-accent)" }}>
          {t("tunnels.headerTitle")}
        </div>
        <div className="text-[11px] ml-2" style={{ color: "var(--moba-text-muted)" }}>
          {t("tunnels.headerSubtitle")}
        </div>
      </div>

      {!tauri && (
        <div
          className="px-4 py-1.5 text-[11px] border-b shrink-0 flex items-center gap-1.5"
          style={{
            background: "rgba(255,196,0,0.12)",
            borderColor: "var(--moba-divider)",
            color: "var(--moba-text-muted)",
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
          style={{ borderColor: "var(--moba-divider)", background: "var(--moba-panel-bg)" }}
        >
          <table data-testid="tunnel-list" className="w-full text-[12px] border-collapse">
            <thead>
              <tr style={{ background: "var(--moba-quick-bg)", color: "var(--moba-text)" }}>
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
                  <td colSpan={8} className="text-center py-6" style={{ color: "var(--moba-text-muted)" }}>
                    {t("tunnels.loadingList")}
                  </td>
                </tr>
              )}
              {!loading && tunnels.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center py-8" style={{ color: "var(--moba-text-muted)" }}>
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
        style={{ background: "var(--moba-quick-bg)", borderColor: "var(--moba-divider)" }}
      >
        <button data-testid="tunnel-new" type="button" className="moba-btn flex items-center gap-1.5" onClick={handleNew}>
          <Plus className="w-3.5 h-3.5" /> {t("tunnels.newSshTunnel")}
        </button>
        <button
          data-testid="tunnel-start-all"
          type="button"
          className="moba-btn flex items-center gap-1.5"
          onClick={handleStartAll}
          disabled={busy || tunnels.length === 0}
        >
          <Play className="w-3.5 h-3.5" style={{ color: "#1f7a4a" }} /> {t("tunnels.startAllTunnels")}
        </button>
        <button
          data-testid="tunnel-stop-all"
          type="button"
          className="moba-btn flex items-center gap-1.5"
          onClick={handleStopAll}
          disabled={busy || tunnels.length === 0}
        >
          <Square className="w-3.5 h-3.5" style={{ color: "#b22222" }} /> {t("tunnels.stopAllTunnels")}
        </button>
        {onClose && (
          <button
            data-testid="tunnel-exit"
            type="button"
            className="moba-btn flex items-center gap-1.5"
            onClick={onClose}
            title={t("tunnels.exitTitle")}
          >
            <LogOut className="w-3.5 h-3.5" /> {t("tunnels.exit")}
          </button>
        )}
        <div className="flex-1" />
        <span className="text-[11px]" style={{ color: "var(--moba-text-muted)" }}>
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

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-2 py-1.5 text-[11px] font-semibold text-center border-b ${className}`}
      style={{ borderColor: "var(--moba-divider)", color: "var(--moba-text)" }}
    >
      {children}
    </th>
  );
}

function StatusBadge({ status, error }: { status?: TunnelStatus; error?: string }) {
  const t = useT();
  const s = status ?? "stopped";
  let icon: React.ReactNode = <CircleDot className="w-3 h-3" style={{ color: "var(--moba-text-muted)" }} />;
  let label = t("tunnels.statusStopped");
  let color = "var(--moba-text-muted)";
  if (s === "running") {
    icon = <CheckCircle2 className="w-3 h-3" style={{ color: "#1f7a4a" }} />;
    label = t("tunnels.statusRunning");
    color = "#1f7a4a";
  } else if (s === "starting") {
    icon = <Loader2 className="w-3 h-3 animate-spin" style={{ color: "var(--moba-accent)" }} />;
    label = t("tunnels.statusStarting");
    color = "var(--moba-accent)";
  } else if (s === "error") {
    icon = <AlertCircle className="w-3 h-3" style={{ color: "#b22222" }} />;
    label = t("tunnels.statusError");
    color = "#b22222";
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px]"
      style={{ color }}
      title={error ?? label}
    >
      {icon}
      {label}
    </span>
  );
}

function TunnelRow({
  tunnel,
  index,
  total,
  status,
  onStart,
  onStop,
  onEdit,
  onEditKey,
  onTest,
  onClone,
  onDelete,
  onMoveUp,
  onMoveDown,
  onToggleAutostart,
}: {
  tunnel: TunnelConfig;
  index: number;
  total: number;
  status?: TunnelStatusInfo;
  onStart: () => void;
  onStop: () => void;
  onEdit: () => void;
  onEditKey: () => void;
  onTest: () => void;
  onClone: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onToggleAutostart: () => void;
}) {
  const t = useT();
  const running = status?.status === "running" || status?.status === "starting";
  const dest =
    tunnel.kind === "Dynamic"
      ? t("tunnels.dynamicSocks")
      : `${tunnel.destHost || "?"}:${tunnel.destPort || "?"}`;
  const sshLabel = `${tunnel.ssh.username || "?"}@${tunnel.ssh.host || "?"}:${tunnel.ssh.port || 22}`;
  // The backend annotates each tunnel with `authStatus` so the masked
  // indicator stays visible even when the password was stripped from disk
  // (`saveAuth=false` keeps it only in the in-memory cache). Without this
  // hint the row would look empty even though Start would succeed using
  // the cached secret.
  const authStatus: TunnelAuthStatus =
    tunnel.ssh.authStatus ??
    (tunnel.ssh.authMethod === "Agent"
      ? "agent"
      : tunnel.ssh.authData
        ? tunnel.ssh.authData.startsWith("vault:")
          ? "vault"
          : "plaintext"
        : "none");
  const hasSecret =
    authStatus === "vault" || authStatus === "session" || authStatus === "plaintext";
  const authPreview = useMemo(() => {
    if (tunnel.ssh.authMethod === "Agent") return "agent";
    if (tunnel.ssh.authMethod === "PrivateKey") {
      const data = tunnel.ssh.authData ?? "";
      if (!data) return "(none)";
      return data.length > 24 ? `…${data.slice(-22)}` : data;
    }
    if (!hasSecret) return "(none)";
    return "••••••••";
  }, [tunnel.ssh.authMethod, tunnel.ssh.authData, hasSecret]);

  return (
    <tr
      data-testid="tunnel-row"
      data-tunnel-id={tunnel.id}
      className="border-b"
      style={{ borderColor: "var(--moba-divider)" }}
    >
      <Td className="text-center">
        <div className="inline-flex items-center gap-0.5 text-[10px]" style={{ color: "var(--moba-text-muted)" }}>
          <button
            data-testid="tunnel-row-move-up"
            type="button"
            className="px-1 hover:text-[var(--moba-accent)] disabled:opacity-30"
            title={t("tunnels.rowMoveUp")}
            onClick={onMoveUp}
            disabled={index === 0}
          >
            ▲
          </button>
          <GripVertical className="w-3 h-3" />
          <button
            data-testid="tunnel-row-move-down"
            type="button"
            className="px-1 hover:text-[var(--moba-accent)] disabled:opacity-30"
            title={t("tunnels.rowMoveDown")}
            onClick={onMoveDown}
            disabled={index === total - 1}
          >
            ▼
          </button>
        </div>
      </Td>
      <Td>
        <div className="font-semibold text-[12px]">{tunnel.name || t("tunnels.unnamed")}</div>
        {tunnel.description && (
          <div className="text-[10.5px]" style={{ color: "var(--moba-text-muted)" }}>
            {tunnel.description}
          </div>
        )}
      </Td>
      <Td className="text-center">
        <span
          className="inline-block px-1.5 py-0.5 rounded text-[11px]"
          style={{
            background: "var(--moba-selected)",
            color: "var(--moba-accent)",
          }}
        >
          {tunnel.kind}
        </span>
      </Td>
      <Td className="text-center">
        <div className="flex items-center justify-center gap-1.5">
          <button
            data-testid="tunnel-row-toggle"
            type="button"
            title={running ? t("tunnels.rowStop") : t("tunnels.rowStart")}
            className="p-1 rounded hover:bg-[var(--moba-hover)]"
            onClick={running ? onStop : onStart}
          >
            {running ? (
              <Square className="w-3.5 h-3.5" style={{ color: "#b22222" }} />
            ) : (
              <Play className="w-3.5 h-3.5" style={{ color: "#1f7a4a" }} />
            )}
          </button>
          <StatusBadge status={status?.status} error={status?.error} />
        </div>
        {status?.status === "error" && status.error && (
          <div className="text-[10.5px] mt-0.5 truncate max-w-[180px] mx-auto" title={status.error} style={{ color: "#b22222" }}>
            {status.error}
          </div>
        )}
      </Td>
      <Td className="text-center moba-mono text-[12px]">
        {tunnel.listenHost}:{tunnel.listenPort || "?"}
      </Td>
      <Td className="moba-mono text-[12px]">{dest}</Td>
      <Td>
        <div className="flex items-center gap-1">
          <span className="moba-mono text-[12px]">{sshLabel}</span>
          <span className="text-[10.5px] px-1 rounded" style={{ background: "var(--moba-hover)", color: "var(--moba-text-muted)" }}>
            {tunnel.ssh.authMethod}
          </span>
          <span className="text-[10.5px] moba-mono" style={{ color: "var(--moba-text-muted)" }}>
            {authPreview}
          </span>
        </div>
      </Td>
      <Td className="text-center">
        <div className="flex items-center justify-center gap-1">
          <IconBtn testId="tunnel-row-edit" title={t("tunnels.rowEdit")} onClick={onEdit}>
            <Pencil className="w-3.5 h-3.5" style={{ color: "#2b5d8b" }} />
          </IconBtn>
          <IconBtn testId="tunnel-row-edit-key" title={t("tunnels.rowEditKey")} onClick={onEditKey}>
            <KeyIcon className="w-3.5 h-3.5" style={{ color: "#c97a23" }} />
          </IconBtn>
          <IconBtn testId="tunnel-row-test" title={t("tunnels.rowTest")} onClick={onTest}>
            <Activity className="w-3.5 h-3.5" style={{ color: "#1f7a4a" }} strokeWidth={2.5} />
          </IconBtn>
          <IconBtn testId="tunnel-row-clone" title={t("tunnels.rowClone")} onClick={onClone}>
            <Copy className="w-3.5 h-3.5" style={{ color: "#7a3d9d" }} />
          </IconBtn>
          <IconBtn
            testId="tunnel-row-autostart"
            title={tunnel.autostart ? t("tunnels.rowAutostartOn") : t("tunnels.rowAutostartOff")}
            onClick={onToggleAutostart}
          >
            <Zap
              className="w-3.5 h-3.5"
              style={{ color: tunnel.autostart ? "#c97a23" : "var(--moba-text-muted)" }}
            />
          </IconBtn>
          <IconBtn testId="tunnel-row-delete" title={t("tunnels.rowDelete")} onClick={onDelete}>
            <Trash2 className="w-3.5 h-3.5" style={{ color: "#b22222" }} />
          </IconBtn>
          <IconBtn testId="tunnel-row-power" title={running ? t("tunnels.rowStop") : t("tunnels.rowStart")} onClick={running ? onStop : onStart}>
            <Power
              className="w-3.5 h-3.5"
              style={{ color: running ? "#1f7a4a" : "var(--moba-text-muted)" }}
            />
          </IconBtn>
        </div>
      </Td>
    </tr>
  );
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <td className={`px-2 py-1.5 align-middle ${className}`}>
      {children}
    </td>
  );
}

function IconBtn({
  title,
  onClick,
  children,
  testId,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      data-testid={testId}
      type="button"
      className="p-1 rounded hover:bg-[var(--moba-hover)]"
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// Re-export so other modules don't have to think about the manager file
export { defaultTunnel };

function ActivityLog({
  logs,
  expanded,
  onToggle,
  onClear,
  listRef,
}: {
  logs: TunnelLogEntry[];
  expanded: boolean;
  onToggle: () => void;
  onClear: () => void;
  listRef: React.RefObject<HTMLDivElement>;
}) {
  const t = useT();
  const errorCount = logs.filter((l) => l.level === "error").length;
  const latest = logs.length > 0 ? logs[logs.length - 1] : null;

  // Auto-scroll to the newest entry whenever the panel is open and a new
  // log lands. Skipping this when collapsed keeps the toggle bar stable.
  useEffect(() => {
    if (!expanded) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logs, expanded, listRef]);

  return (
    <div
      data-testid="tunnel-activity-log"
      className="border-t shrink-0 flex flex-col"
      style={{ borderColor: "var(--moba-divider)", background: "var(--moba-panel-bg)" }}
    >
      <button
        type="button"
        data-testid="tunnel-activity-log-toggle"
        className="h-7 px-3 flex items-center gap-2 text-[11px] hover:bg-[var(--moba-hover)] text-left"
        onClick={onToggle}
        style={{ color: "var(--moba-text)" }}
      >
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
        <span className="font-semibold">{t("tunnels.logTitle")}</span>
        <span style={{ color: "var(--moba-text-muted)" }}>
          {t("tunnels.logCount", { count: logs.length })}
        </span>
        {errorCount > 0 && (
          <span
            className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
            style={{ background: "rgba(178,34,34,0.15)", color: "#b22222" }}
          >
            {t("tunnels.logErrors", { count: errorCount })}
          </span>
        )}
        <div className="flex-1" />
        {!expanded && latest && (
          <span
            className="truncate max-w-[60%]"
            style={{
              color:
                latest.level === "error"
                  ? "#b22222"
                  : latest.level === "success"
                    ? "#1f7a4a"
                    : "var(--moba-text-muted)",
            }}
            title={latest.text}
          >
            {latest.text}
          </span>
        )}
      </button>
      {expanded && (
        <div className="flex flex-col" style={{ maxHeight: 180 }}>
          <div className="flex items-center justify-end px-2 py-1 border-b" style={{ borderColor: "var(--moba-divider)" }}>
            <button
              type="button"
              data-testid="tunnel-activity-log-clear"
              className="moba-btn flex items-center gap-1 text-[11px]"
              onClick={onClear}
              disabled={logs.length === 0}
              title={t("tunnels.logClear")}
            >
              <Trash className="w-3 h-3" /> {t("tunnels.logClear")}
            </button>
          </div>
          <div
            ref={listRef}
            className="flex-1 overflow-auto px-3 py-1.5 moba-mono text-[11px] leading-[1.6]"
            style={{ background: "var(--moba-bg)" }}
          >
            {logs.length === 0 ? (
              <div className="text-center py-3" style={{ color: "var(--moba-text-muted)" }}>
                {t("tunnels.logEmpty")}
              </div>
            ) : (
              logs.map((entry) => <ActivityLogRow key={entry.id} entry={entry} />)
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ActivityLogRow({ entry }: { entry: TunnelLogEntry }) {
  const color =
    entry.level === "error"
      ? "#b22222"
      : entry.level === "success"
        ? "#1f7a4a"
        : "var(--moba-text)";
  return (
    <div className="flex items-start gap-2" style={{ color }}>
      <span style={{ color: "var(--moba-text-muted)" }}>{formatLogTime(entry.ts)}</span>
      <span className="whitespace-pre-wrap break-words">{entry.text}</span>
    </div>
  );
}

function formatLogTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
