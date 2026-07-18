import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  HardDrive,
  Laptop2,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import type { ReactNode } from "react";
import { useT, type TranslateFn } from "../../lib/i18n";
import type { SockscapLifecycleSnapshot, SockscapSupportLevel } from "../../lib/sockscap";
import { useSockscapStore } from "../../stores/sockscapStore";

export function SockscapLifecycle() {
  const t = useT();
  const lifecycle = useSockscapStore((state) => state.lifecycle);
  const loading = useSockscapStore((state) => state.loading);
  const actionPending = useSockscapStore((state) => state.actionPending);
  const refresh = useSockscapStore((state) => state.refresh);
  const recover = useSockscapStore((state) => state.recover);
  const setRestoreOnSystemLogin = useSockscapStore((state) => state.setRestoreOnSystemLogin);

  if (!lifecycle) {
    return (
      <div className="mx-auto max-w-5xl rounded-lg border p-8 text-center text-[12px] text-[var(--taomni-text-muted)]" style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-card-bg)" }}>
        {loading ? t("common.loading") : t("sockscap.lifecycleUnavailable")}
      </div>
    );
  }

  const preferenceEnabled = lifecycle.preferences.restoreOnSystemLogin;
  const toggleDisabled = actionPending !== null
    || (!preferenceEnabled && !lifecycle.canEnableAutoRestore);

  return (
    <div className="mx-auto max-w-5xl space-y-4" data-testid="sockscap-lifecycle">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t("sockscap.lifecycleTitle")}</h1>
          <p className="mt-1 max-w-3xl text-[12px] leading-5 text-[var(--taomni-text-muted)]">
            {t("sockscap.lifecycleDescription")}
          </p>
        </div>
        <LifecycleButton
          testId="sockscap-lifecycle-refresh"
          label={t("common.refresh")}
          disabled={loading || actionPending !== null}
          onClick={() => void refresh()}
          icon={<RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <LifecyclePanel title={t("sockscap.autoRestoreTitle")} icon={<Laptop2 className="h-4 w-4" />}>
          <label className="flex items-start justify-between gap-4" htmlFor="sockscap-auto-restore">
            <span className="min-w-0">
              <span className="block text-[12px] font-semibold">{t("sockscap.autoRestoreLogin")}</span>
              <span className="mt-1 block text-[10px] leading-4 text-[var(--taomni-text-muted)]">
                {t("sockscap.autoRestoreCommittedOnly")}
              </span>
            </span>
            <input
              id="sockscap-auto-restore"
              data-testid="sockscap-auto-restore"
              type="checkbox"
              role="switch"
              checked={preferenceEnabled}
              disabled={toggleDisabled}
              onChange={(event) => {
                void setRestoreOnSystemLogin(event.currentTarget.checked).catch(() => undefined);
              }}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--taomni-accent)] disabled:opacity-50"
            />
          </label>
          <StatusLine
            good={lifecycle.autoRestoreReady}
            label={autoRestoreStatusText(t, lifecycle)}
            code={lifecycle.autoRestoreStatusCode}
          />
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Fact label={t("sockscap.osRegistration")} value={lifecycle.systemLoginRegistered ? t("common.enabled") : t("common.disabled")} />
            <Fact label={t("sockscap.lastCommittedSnapshot")} value={lifecycle.lastCommittedConfig ? `r${lifecycle.lastCommittedConfig.revision}` : t("sockscap.noneYet")} />
          </div>
          {lifecycle.lastCommittedConfig && (
            <p className="mt-2 break-words text-[10px] leading-4 text-[var(--taomni-text-muted)]">
              {t("sockscap.committedProfiles", {
                count: lifecycle.lastCommittedConfig.profileIds.length,
                profiles: lifecycle.lastCommittedConfig.profileIds.join(", "),
              })}
            </p>
          )}
        </LifecyclePanel>

        <LifecyclePanel title={t("sockscap.recoveryJournalTitle")} icon={<HardDrive className="h-4 w-4" />}>
          <div className="grid grid-cols-2 gap-2">
            <Fact label={t("sockscap.recoveryPhase")} value={lifecycle.recovery.phase.replaceAll("_", " ")} />
            <Fact label={t("sockscap.recoveryGeneration")} value={String(lifecycle.recovery.generation)} />
            <Fact label={t("sockscap.cleanupMarker")} value={lifecycle.recovery.cleanupRequired ? t("sockscap.present") : t("sockscap.clean")} />
            <Fact label={t("sockscap.helperHeartbeat")} value={formatTimestamp(lifecycle.recovery.lastHeartbeatAt)} />
          </div>
          <StatusLine
            good={!lifecycle.status.recoveryRequired}
            label={lifecycle.status.recoveryRequired ? t("sockscap.cleanupConfirmationRequired") : t("sockscap.recoveryJournalHealthy")}
            code={lifecycle.recovery.lastErrorCode ?? lifecycle.recovery.phase.toUpperCase()}
          />
          {lifecycle.status.recoveryRequired && (
            <LifecycleButton
              testId="sockscap-lifecycle-recover"
              label={t("sockscap.recover")}
              disabled={actionPending !== null}
              onClick={() => void recover()}
              icon={<RotateCcw className="h-3.5 w-3.5" />}
              primary
            />
          )}
        </LifecyclePanel>
      </div>

      <LifecyclePanel title={t("sockscap.releaseGatesTitle")} icon={<ShieldCheck className="h-4 w-4" />}>
        <p className="mb-3 text-[10px] leading-4 text-[var(--taomni-text-muted)]">
          {t("sockscap.releaseGatesDescription")}
        </p>
        <div className="space-y-2" data-testid="sockscap-lifecycle-gates">
          {lifecycle.capabilities.items.map((item) => (
            <div key={item.id} className="flex items-start gap-3 rounded-md border px-3 py-2.5" style={{ borderColor: "var(--taomni-card-border)" }}>
              <GateIcon level={item.level} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-semibold">{item.name}</span>
                  {item.requiredForStart && (
                    <span className="rounded-full border px-1.5 py-0.5 text-[8px] uppercase tracking-wide" style={{ borderColor: "var(--taomni-warning-border)", color: "var(--taomni-warning-text)" }}>
                      {t("sockscap.startBlocking")}
                    </span>
                  )}
                  <span className="text-[9px] uppercase tracking-wide text-[var(--taomni-text-muted)]">{item.level.replaceAll("_", " ")}</span>
                </div>
                <p className="mt-1 text-[10px] leading-4 text-[var(--taomni-text-muted)]">{item.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </LifecyclePanel>
    </div>
  );
}

function LifecyclePanel({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
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

function LifecycleButton({ testId, label, disabled, onClick, icon, primary = false }: {
  testId: string;
  label: string;
  disabled: boolean;
  onClick: () => void;
  icon: ReactNode;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="mt-3 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-50"
      style={primary
        ? { background: "var(--taomni-accent)", borderColor: "var(--taomni-accent)", color: "white" }
        : { background: "var(--taomni-button-from)", borderColor: "var(--taomni-input-border)" }}
    >
      {icon}
      {label}
    </button>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border px-2.5 py-2" style={{ borderColor: "var(--taomni-card-border)" }}>
      <div className="text-[9px] uppercase tracking-wide text-[var(--taomni-text-muted)]">{label}</div>
      <div className="mt-1 truncate text-[11px] font-semibold capitalize" title={value}>{value}</div>
    </div>
  );
}

function StatusLine({ good, label, code }: { good: boolean; label: string; code: string }) {
  return (
    <div className="mt-3 flex items-start gap-2 rounded-md border px-2.5 py-2 text-[10px]" style={{ borderColor: good ? "var(--taomni-success-border)" : "var(--taomni-warning-border)", background: good ? "var(--taomni-success-bg)" : "var(--taomni-warning-bg)" }}>
      {good ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />}
      <span className="min-w-0 flex-1 leading-4">{label}</span>
      <code className="shrink-0 text-[8px] text-[var(--taomni-text-muted)]">{code}</code>
    </div>
  );
}

function GateIcon({ level }: { level: SockscapSupportLevel }) {
  if (level === "supported") return <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />;
  if (level === "degraded" || level === "unknown") return <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />;
  if (level === "not_implemented") return <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />;
  return <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />;
}

function autoRestoreStatusText(t: TranslateFn, lifecycle: SockscapLifecycleSnapshot): string {
  const keys: Record<string, string> = {
    READY: "sockscap.autoRestoreReady",
    DISABLED_BY_USER: "sockscap.autoRestoreDisabled",
    CAPTURE_ADAPTER_NOT_READY: "sockscap.autoRestoreCaptureGate",
    AUTOSTART_REGISTRATION_UNAVAILABLE: "sockscap.autoRestoreRegistrationUnavailable",
    AUTOSTART_REGISTRATION_MISMATCH: "sockscap.autoRestoreRegistrationMismatch",
    RECOVERY_REQUIRED: "sockscap.autoRestoreRecoveryGate",
    ENGINE_TRANSITION_IN_PROGRESS: "sockscap.autoRestoreTransitionGate",
    LAST_COMMITTED_CONFIG_MISSING: "sockscap.autoRestoreSnapshotGate",
  };
  return t(keys[lifecycle.autoRestoreStatusCode] ?? "sockscap.autoRestoreUnknown", {
    code: lifecycle.autoRestoreStatusCode,
  });
}

function formatTimestamp(value: number | null): string {
  if (!value) return "—";
  return new Date(value * 1000).toLocaleString();
}
