import { Activity, AlertCircle, CheckCircle2, CircleDot, Copy, GripVertical, Key as KeyIcon, Loader2, Pencil, Play, Power, Square, Trash2, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { useT } from "../../../lib/i18n";
import { type TunnelAuthStatus, type TunnelConfig, type TunnelStatus, type TunnelStatusInfo } from "../../../lib/tunnel";

export function Th({ children, className = "" }: { children: React.ReactNode; className?: string; }) {
  return (
    <th
      className={`px-2 py-1.5 text-[11px] font-semibold text-center border-b ${className}`}
      style={{ borderColor: "var(--taomni-divider)", color: "var(--taomni-text)" }}
    >
      {children}
    </th>
  );
}

export function StatusBadge({ status, error }: { status?: TunnelStatus; error?: string; }) {
  const t = useT();
  const s = status ?? "stopped";
  let icon: React.ReactNode = <CircleDot className="w-3 h-3" style={{ color: "var(--taomni-text-muted)" }} />;
  let label = t("tunnels.statusStopped");
  let color = "var(--taomni-text-muted)";
  if (s === "running") {
    icon = <CheckCircle2 className="w-3 h-3" style={{ color: "#1f7a4a" }} />;
    label = t("tunnels.statusRunning");
    color = "#1f7a4a";
  } else if (s === "starting") {
    icon = <Loader2 className="w-3 h-3 animate-spin" style={{ color: "var(--taomni-accent)" }} />;
    label = t("tunnels.statusStarting");
    color = "var(--taomni-accent)";
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

export function TunnelRow({
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
  const [revealed, setRevealed] = useState(false);

  return (
    <tr
      data-testid="tunnel-row"
      data-tunnel-id={tunnel.id}
      className="border-b"
      style={{ borderColor: "var(--taomni-divider)" }}
    >
      <Td className="text-center">
        <div className="inline-flex items-center gap-0.5 text-[10px]" style={{ color: "var(--taomni-text-muted)" }}>
          <button
            data-testid="tunnel-row-move-up"
            type="button"
            className="px-1 hover:text-[var(--taomni-accent)] disabled:opacity-30"
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
            className="px-1 hover:text-[var(--taomni-accent)] disabled:opacity-30"
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
          <div className="text-[10.5px]" style={{ color: "var(--taomni-text-muted)" }}>
            {tunnel.description}
          </div>
        )}
      </Td>
      <Td className="text-center">
        <span
          className="inline-block px-1.5 py-0.5 rounded text-[11px]"
          style={{
            background: "var(--taomni-selected)",
            color: "var(--taomni-accent)",
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
            className="p-1 rounded hover:bg-[var(--taomni-hover)]"
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
      <Td className="text-center taomni-mono text-[12px]">
        {tunnel.listenHost}:{tunnel.listenPort || "?"}
      </Td>
      <Td className="taomni-mono text-[12px]">{dest}</Td>
      <Td>
        <div className="flex items-center gap-1">
          <span className="taomni-mono text-[12px]">{sshLabel}</span>
          <span className="text-[10.5px] px-1 rounded" style={{ background: "var(--taomni-hover)", color: "var(--taomni-text-muted)" }}>
            {tunnel.ssh.authMethod}
          </span>
          <button
            data-testid="tunnel-row-toggle-reveal"
            type="button"
            className="text-[10.5px] taomni-mono hover:underline cursor-pointer"
            style={{ color: "var(--taomni-text-muted)" }}
            onClick={() => setRevealed((v) => !v)}
            title={revealed ? t("tunnels.rowHide") : t("tunnels.rowShow")}
          >
            {revealed && tunnel.ssh.authData ? tunnel.ssh.authData : authPreview}
          </button>
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
              style={{ color: tunnel.autostart ? "#c97a23" : "var(--taomni-text-muted)" }}
            />
          </IconBtn>
          <IconBtn testId="tunnel-row-delete" title={t("tunnels.rowDelete")} onClick={onDelete}>
            <Trash2 className="w-3.5 h-3.5" style={{ color: "#b22222" }} />
          </IconBtn>
          <IconBtn testId="tunnel-row-power" title={running ? t("tunnels.rowStop") : t("tunnels.rowStart")} onClick={running ? onStop : onStart}>
            <Power
              className="w-3.5 h-3.5"
              style={{ color: running ? "#1f7a4a" : "var(--taomni-text-muted)" }}
            />
          </IconBtn>
        </div>
      </Td>
    </tr>
  );
}

export function Td({ children, className = "" }: { children: React.ReactNode; className?: string; }) {
  return (
    <td className={`px-2 py-1.5 align-middle ${className}`}>
      {children}
    </td>
  );
}

export function IconBtn({
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
      className="p-1 rounded hover:bg-[var(--taomni-hover)]"
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
