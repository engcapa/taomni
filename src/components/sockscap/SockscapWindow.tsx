import { useCallback, useEffect, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CircleGauge,
  FileKey2,
  Network,
  Play,
  RefreshCw,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Square,
  Workflow,
  X,
} from "lucide-react";
import { sockscapCloseWindow, type SockscapEngineState } from "../../lib/sockscap";
import { useT } from "../../lib/i18n";
import { isTauriRuntime } from "../../lib/runtime";
import {
  attachSockscapEventBridge,
  useSockscapStore,
  type SockscapSection,
} from "../../stores/sockscapStore";
import { LanguageSwitcher } from "../window/LanguageSwitcher";
import { WindowControls } from "../window/WindowControls";
import { WindowResizeHandles } from "../window/WindowResizeHandles";
import { SockscapProfiles } from "./SockscapProfiles";
import { SockscapRules } from "./SockscapRules";

export function SockscapWindow() {
  const t = useT();
  const section = useSockscapStore((state) => state.section);
  const initialized = useSockscapStore((state) => state.initialized);
  const loading = useSockscapStore((state) => state.loading);
  const actionPending = useSockscapStore((state) => state.actionPending);
  const error = useSockscapStore((state) => state.error);
  const capabilities = useSockscapStore((state) => state.capabilities);
  const status = useSockscapStore((state) => state.status);
  const profiles = useSockscapStore((state) => state.profiles);
  const egressSessions = useSockscapStore((state) => state.egressSessions);
  const ruleSources = useSockscapStore((state) => state.ruleSources);
  const stats = useSockscapStore((state) => state.stats);
  const alerts = useSockscapStore((state) => state.alerts);
  const setSection = useSockscapStore((state) => state.setSection);
  const initialize = useSockscapStore((state) => state.initialize);
  const refresh = useSockscapStore((state) => state.refresh);
  const start = useSockscapStore((state) => state.start);
  const stop = useSockscapStore((state) => state.stop);
  const recover = useSockscapStore((state) => state.recover);
  const dismissError = useSockscapStore((state) => state.dismissError);

  useEffect(() => {
    document.title = `${t("sockscap.title")} — Taomni`;
  }, [t]);

  useEffect(() => {
    void initialize();
    return attachSockscapEventBridge();
  }, [initialize]);

  const closeWindow = useCallback(() => {
    void sockscapCloseWindow().catch(() => window.close());
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        event.preventDefault();
        closeWindow();
      })
      .then((next) => {
        if (disposed) next();
        else unlisten = next;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [closeWindow]);

  const startDrag = (event: ReactMouseEvent) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button,input,select,textarea,[data-no-window-drag]")) return;
    void getCurrentWindow().startDragging().catch(() => undefined);
  };

  const nav: Array<{ id: SockscapSection; icon: ReactNode; label: string }> = [
    { id: "overview", icon: <CircleGauge className="h-4 w-4" />, label: t("sockscap.navOverview") },
    { id: "profiles", icon: <Workflow className="h-4 w-4" />, label: t("sockscap.navProfiles") },
    { id: "rules", icon: <FileKey2 className="h-4 w-4" />, label: t("sockscap.navRules") },
    { id: "dashboard", icon: <BarChart3 className="h-4 w-4" />, label: t("sockscap.navDashboard") },
    { id: "lifecycle", icon: <ShieldCheck className="h-4 w-4" />, label: t("sockscap.navLifecycle") },
  ];

  return (
    <div
      className="h-screen min-h-0 overflow-hidden flex flex-col"
      style={{ background: "var(--taomni-bg)", color: "var(--taomni-text)" }}
      data-testid="sockscap-window"
    >
      <WindowResizeHandles />
      <header
        className="h-10 shrink-0 flex items-stretch border-b select-none"
        style={{
          background: "linear-gradient(90deg, var(--taomni-titlebar-from), var(--taomni-titlebar-to))",
          borderColor: "var(--taomni-chrome-border)",
        }}
        data-window-drag
        onMouseDown={startDrag}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3" data-window-drag>
          <Network className="h-4 w-4 text-[var(--taomni-accent)]" aria-hidden="true" />
          <span className="font-semibold text-[13px] tracking-wide">{t("sockscap.title")}</span>
          <span className="truncate text-[11px] text-[var(--taomni-text-muted)]">
            {t("sockscap.subtitle")}
          </span>
        </div>
        <LanguageSwitcher />
        <WindowControls onClose={closeWindow} />
      </header>

      <div className="min-h-0 flex flex-1">
        <aside
          className="w-52 shrink-0 border-r p-3 flex flex-col gap-1"
          style={{ background: "var(--taomni-sidebar-bg)", borderColor: "var(--taomni-sidebar-border)" }}
          aria-label={t("sockscap.navigation")}
        >
          <StatusPill state={status?.state ?? "disabled"} label={status?.message ?? t("common.loading")} />
          <nav className="mt-3 space-y-1">
            {nav.map((item) => (
              <button
                key={item.id}
                type="button"
                data-testid={`sockscap-nav-${item.id}`}
                aria-current={section === item.id ? "page" : undefined}
                onClick={() => setSection(item.id)}
                className="w-full rounded-md px-2.5 py-2 flex items-center gap-2 text-left text-[12px] transition-colors"
                style={section === item.id
                  ? { background: "var(--taomni-selected)", color: "var(--taomni-text)" }
                  : { color: "var(--taomni-text-muted)" }}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
          <div className="mt-auto text-[10px] leading-4 text-[var(--taomni-text-muted)]">
            {capabilities?.platform ?? t("sockscap.platformUnknown")}
            {capabilities && !capabilities.captureImplemented ? ` · ${t("sockscap.previewOnly")}` : ""}
          </div>
        </aside>

        <main className="min-w-0 flex-1 overflow-auto p-5" data-testid={`sockscap-section-${section}`}>
          {error && (
            <InlineNotice tone="error" icon={<AlertTriangle className="h-4 w-4" />}>
              <span className="min-w-0 flex-1 break-words">{error}</span>
              <button type="button" aria-label={t("common.close")} onClick={dismissError}>
                <X className="h-4 w-4" />
              </button>
            </InlineNotice>
          )}
          {status?.recoveryRequired && (
            <InlineNotice tone="warning" icon={<RotateCcw className="h-4 w-4" />}>
              <span className="flex-1">{t("sockscap.recoveryRequired")}</span>
              <ActionButton
                testId="sockscap-recover"
                disabled={actionPending !== null}
                onClick={() => void recover()}
                label={t("sockscap.recover")}
              />
            </InlineNotice>
          )}

          {section === "overview" && (
            <Overview
              loading={loading && !initialized}
              capabilities={capabilities}
              statusState={status?.state ?? "disabled"}
              profiles={profiles.length}
              egressSessions={egressSessions}
              rules={ruleSources.length}
              connections={stats?.totals.connections ?? 0}
              bytesUp={stats?.totals.bytesUp ?? 0}
              bytesDown={stats?.totals.bytesDown ?? 0}
              alerts={alerts.length}
              actionPending={actionPending}
              onRefresh={() => void refresh()}
              onStart={() => void start()}
              onStop={() => void stop()}
            />
          )}
          {section === "profiles" && <SockscapProfiles />}
          {section === "rules" && <SockscapRules />}
          {section !== "overview" && section !== "profiles" && section !== "rules" && (
            <SectionScaffold section={section} />
          )}
        </main>
      </div>
    </div>
  );
}

function Overview({
  loading,
  capabilities,
  statusState,
  profiles,
  egressSessions,
  rules,
  connections,
  bytesUp,
  bytesDown,
  alerts,
  actionPending,
  onRefresh,
  onStart,
  onStop,
}: {
  loading: boolean;
  capabilities: ReturnType<typeof useSockscapStore.getState>["capabilities"];
  statusState: SockscapEngineState;
  profiles: number;
  egressSessions: ReturnType<typeof useSockscapStore.getState>["egressSessions"];
  rules: number;
  connections: number;
  bytesUp: number;
  bytesDown: number;
  alerts: number;
  actionPending: ReturnType<typeof useSockscapStore.getState>["actionPending"];
  onRefresh: () => void;
  onStart: () => void;
  onStop: () => void;
}) {
  const t = useT();
  const running = statusState === "active" || statusState === "degraded" || statusState === "user_action_required";
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t("sockscap.overviewTitle")}</h1>
          <p className="mt-1 text-[12px] text-[var(--taomni-text-muted)]">{t("sockscap.overviewDescription")}</p>
        </div>
        <div className="flex items-center gap-2">
          <ActionButton
            testId="sockscap-refresh"
            disabled={loading}
            onClick={onRefresh}
            label={t("common.refresh")}
            icon={<RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />}
          />
          {running ? (
            <ActionButton
              testId="sockscap-stop"
              disabled={actionPending !== null}
              onClick={onStop}
              label={t("sockscap.stop")}
              icon={<Square className="h-3.5 w-3.5" />}
              primary
            />
          ) : (
            <ActionButton
              testId="sockscap-start"
              disabled={actionPending !== null || statusState === "recovery_required"}
              onClick={onStart}
              label={t("sockscap.start")}
              icon={<Play className="h-3.5 w-3.5" />}
              primary
            />
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label={t("sockscap.profiles")} value={profiles.toLocaleString()} />
        <MetricCard label={t("sockscap.ruleSources")} value={rules.toLocaleString()} />
        <MetricCard label={t("sockscap.connections")} value={connections.toLocaleString()} />
        <MetricCard label={t("sockscap.traffic")} value={`${formatBytes(bytesUp)} ↑ · ${formatBytes(bytesDown)} ↓`} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title={t("sockscap.capabilities")} icon={<ShieldCheck className="h-4 w-4" />}>
          {!capabilities ? (
            <EmptyText>{t("common.loading")}</EmptyText>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-[12px]">
                <span className="font-medium capitalize">{capabilities.platform}</span>
                <span className="text-[var(--taomni-text-muted)]">{capabilities.summary}</span>
              </div>
              {capabilities.items.map((item) => (
                <div key={item.id} className="flex items-start gap-2 rounded-md border p-2.5" style={{ borderColor: "var(--taomni-card-border)" }}>
                  <span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${capabilityDot(item.level)}`} />
                  <div className="min-w-0">
                    <div className="text-[11px] font-medium">{item.name}</div>
                    <div className="mt-0.5 text-[10px] leading-4 text-[var(--taomni-text-muted)]">{item.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title={t("sockscap.egressHealth")} icon={<Activity className="h-4 w-4" />}>
          {egressSessions.length === 0 ? (
            <EmptyText>{t("sockscap.noEgress")}</EmptyText>
          ) : (
            <div className="space-y-2">
              {egressSessions.map((egress) => (
                <div key={egress.id} className="flex items-center gap-3 rounded-md border px-3 py-2.5" style={{ borderColor: "var(--taomni-card-border)" }}>
                  <Network className="h-4 w-4 shrink-0 text-[var(--taomni-accent)]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] font-medium">{egress.name}</div>
                    <div className="truncate text-[10px] text-[var(--taomni-text-muted)]">
                      {egress.protocol} · {egress.endpointHost}:{egress.endpointPort}
                    </div>
                  </div>
                  <span className="rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase" style={availabilityStyle(egress.availability)}>
                    {egress.availability.replaceAll("_", " ")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {alerts > 0 && (
        <InlineNotice tone="warning" icon={<AlertTriangle className="h-4 w-4" />}>
          {t("sockscap.alertCount", { count: alerts })}
        </InlineNotice>
      )}
    </div>
  );
}

function SectionScaffold({ section }: { section: Exclude<SockscapSection, "overview" | "profiles" | "rules"> }) {
  const t = useT();
  const details: Record<Exclude<SockscapSection, "overview" | "profiles" | "rules">, { icon: ReactNode; title: string; description: string }> = {
    dashboard: { icon: <BarChart3 className="h-5 w-5" />, title: t("sockscap.dashboardTitle"), description: t("sockscap.dashboardDescription") },
    lifecycle: { icon: <Settings2 className="h-5 w-5" />, title: t("sockscap.lifecycleTitle"), description: t("sockscap.lifecycleDescription") },
  };
  const detail = details[section];
  return (
    <div className="mx-auto max-w-4xl">
      <Panel title={detail.title} icon={detail.icon}>
        <p className="text-[12px] leading-5 text-[var(--taomni-text-muted)]">{detail.description}</p>
      </Panel>
    </div>
  );
}

function StatusPill({ state, label }: { state: SockscapEngineState; label: string }) {
  return (
    <div className="rounded-md border px-2.5 py-2" style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-card-bg)" }} data-testid="sockscap-status">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${statusDot(state)}`} />
        <span className="text-[10px] font-semibold uppercase tracking-wide">{state.replaceAll("_", " ")}</span>
      </div>
      <div className="mt-1 line-clamp-2 text-[9px] leading-3.5 text-[var(--taomni-text-muted)]">{label}</div>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3" style={{ background: "var(--taomni-card-bg)", borderColor: "var(--taomni-card-border)" }}>
      <div className="text-[10px] uppercase tracking-wide text-[var(--taomni-text-muted)]">{label}</div>
      <div className="mt-1.5 truncate text-[15px] font-semibold">{value}</div>
    </div>
  );
}

function Panel({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border" style={{ background: "var(--taomni-card-bg)", borderColor: "var(--taomni-card-border)" }}>
      <div className="flex items-center gap-2 border-b px-4 py-3 text-[12px] font-semibold" style={{ borderColor: "var(--taomni-card-border)" }}>
        <span className="text-[var(--taomni-accent)]">{icon}</span>
        {title}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function EmptyText({ children }: { children: ReactNode }) {
  return <div className="py-6 text-center text-[11px] text-[var(--taomni-text-muted)]">{children}</div>;
}

function InlineNotice({ tone, icon, children }: { tone: "warning" | "error"; icon: ReactNode; children: ReactNode }) {
  const style = tone === "warning"
    ? { background: "var(--taomni-warning-bg)", borderColor: "var(--taomni-warning-border)", color: "var(--taomni-warning-text)" }
    : { background: "rgba(220, 38, 38, 0.1)", borderColor: "rgba(220, 38, 38, 0.45)", color: "#b91c1c" };
  return (
    <div className="mb-4 flex items-center gap-2 rounded-md border px-3 py-2 text-[11px]" style={style} role="alert">
      <span className="shrink-0">{icon}</span>
      {children}
    </div>
  );
}

function ActionButton({
  testId,
  label,
  icon,
  onClick,
  disabled,
  primary = false,
}: {
  testId: string;
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  disabled: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-50"
      style={primary
        ? { background: "var(--taomni-accent)", borderColor: "var(--taomni-accent)", color: "white" }
        : { background: "var(--taomni-button-from)", borderColor: "var(--taomni-input-border)" }}
    >
      {icon}
      {label}
    </button>
  );
}

function statusDot(state: SockscapEngineState): string {
  if (state === "active") return "bg-emerald-500";
  if (state === "preparing" || state === "stopping") return "bg-sky-500 animate-pulse";
  if (state === "degraded" || state === "user_action_required") return "bg-amber-500";
  if (state === "recovery_required") return "bg-red-500";
  return "bg-slate-400";
}

function capabilityDot(level: string): string {
  if (level === "supported") return "bg-emerald-500";
  if (level === "degraded") return "bg-amber-500";
  if (level === "unsupported" || level === "not_implemented") return "bg-red-500";
  return "bg-slate-400";
}

function availabilityStyle(availability: string): React.CSSProperties {
  if (availability === "ready") return { background: "var(--taomni-success-bg)", color: "var(--taomni-success-text)" };
  if (availability === "user_action_required") return { background: "var(--taomni-warning-bg)", color: "var(--taomni-warning-text)" };
  return { background: "rgba(220, 38, 38, 0.12)", color: "#b91c1c" };
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const amount = value / 1024 ** index;
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}
