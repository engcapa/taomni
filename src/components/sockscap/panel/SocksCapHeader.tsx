import { AlertTriangle, ArrowDownLeft, ArrowUpRight, HelpCircle, Info, Layers, Loader2, Lock, Play, RefreshCw, Shield, Square, X } from "lucide-react";
import { type HelperStatus, type SocksCapCapabilities, type SocksCapConfig, type SocksCapProfile, type SocksCapStatus, type StatsSnapshot } from "../../../lib/sockscap";
import { type MacosSetupGuideMode, phaseTone } from "./configuration";
import { formatSpeed } from "./formatting";


export interface SocksCapHeaderProps {
  t: import("../../../lib/i18n").TranslateFn;
  caps: SocksCapCapabilities | null;
  activeProfiles: SocksCapProfile[];
  stats: StatsSnapshot | null;
  helper: HelperStatus | null;
  running: boolean;
  upSpeed: number;
  downSpeed: number;
  locked: boolean;
  linuxLaunchOnly: boolean;
  tunConflicts: string[];
  setTunWarningOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  status: SocksCapStatus | null;
  busy: boolean;
  onStop: () => Promise<void>;
  startButtonRef: import("react").RefObject<HTMLButtonElement | null>;
  preflightAndStart: (configOverride?: SocksCapConfig) => Promise<boolean>;
  probing: boolean;
  redirectorApprovalWaiting: boolean;
  setMacosSetupError: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  setMacosSetupGuideMode: import("react").Dispatch<import("react").SetStateAction<MacosSetupGuideMode | null>>;
  onRefreshStatus: () => Promise<void>;
  onRecover: (sudoPassword?: string) => Promise<void>;
  onClose: (() => void) | undefined;
}

export function SocksCapHeader(viewProps: SocksCapHeaderProps) {
  return (<div
    data-testid="sockscap-header"
    className="flex items-center gap-2.5 px-3 py-2 border-b border-[var(--taomni-divider)] shrink-0 min-h-[52px]"
  >
    <Shield className="w-4.5 h-4.5 shrink-0 text-[var(--taomni-accent)]" />
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        <div className="text-[14px] font-semibold shrink-0">{viewProps.t("sockscap.title")}</div>
        {viewProps.caps && (
          <span
            data-testid="sockscap-capability-notes"
            className="inline-flex items-center gap-1 min-w-0 text-[10px] text-[var(--taomni-text-muted)]"
            title={viewProps.caps.notes.join("\n") || viewProps.t("sockscap.captureBackendLabel", { backend: viewProps.caps.captureBackend })}
          >
            {viewProps.caps.notes.length > 0 && <Info className="w-3 h-3 shrink-0 text-[var(--taomni-accent)]" />}
            <span className="truncate">
              {viewProps.t("sockscap.backendCompact", { backend: viewProps.caps.captureBackend })}
            </span>
          </span>
        )}
      </div>
      <div
        data-testid="sockscap-header-summary"
        className="mt-0.5 flex items-center gap-2 min-w-0 text-[10px] text-[var(--taomni-text-muted)] whitespace-nowrap"
      >
        <span
          className="inline-flex items-center gap-1 min-w-0"
          title={viewProps.activeProfiles
            .map((p) => `${p.name} (${p.mode === "global" ? viewProps.t("sockscap.badgeGlobal") : viewProps.t("sockscap.badgeApps", { count: p.apps.length })})`)
            .join(", ")}
        >
          <Layers className="w-3 h-3 shrink-0 text-[var(--taomni-accent)]" />
          <span className="truncate">
            {viewProps.t("sockscap.activeProfilesCompact", {
              count: viewProps.activeProfiles.length,
              names: viewProps.activeProfiles.map((p) => p.name).join(", "),
            })}
          </span>
        </span>
        {viewProps.stats && (
          <span
            className="hidden xl:inline shrink-0"
            title={viewProps.t("sockscap.trafficDiagnostics", {
              lastFlow: viewProps.stats.lastFlowAt
                ? new Date(viewProps.stats.lastFlowAt * 1000).toLocaleString()
                : "-",
              quic: viewProps.stats.quicFlowsDropped ?? 0,
              udp: viewProps.stats.udpDirectDatagrams ?? 0,
              mismatch: viewProps.stats.scopeMismatchFlows ?? 0,
            })}
          >
            {viewProps.t("sockscap.trafficCompact", {
              total: viewProps.stats.flowsTotal,
              proxy: viewProps.stats.flowsProxy,
              direct: viewProps.stats.flowsDirect,
            })}
          </span>
        )}
        {viewProps.helper?.running && (
          <span className="hidden 2xl:inline shrink-0 font-mono text-emerald-600 dark:text-emerald-400">
            Helper {viewProps.helper.pid}
          </span>
        )}
        {viewProps.running && (
          <span className="hidden 2xl:inline-flex items-center gap-2 shrink-0 font-mono">
            <span className="inline-flex items-center gap-0.5 text-emerald-500">
              <ArrowUpRight className="w-3 h-3" />
              {formatSpeed(viewProps.upSpeed)}
            </span>
            <span className="inline-flex items-center gap-0.5 text-sky-500">
              <ArrowDownLeft className="w-3 h-3" />
              {formatSpeed(viewProps.downSpeed)}
            </span>
          </span>
        )}
      </div>
    </div>
    {viewProps.locked && (
      <div
        data-testid="sockscap-locked-banner"
        className="min-w-0 max-w-[400px] flex items-center gap-1.5 text-[11px] text-sky-700 dark:text-sky-400"
        title={viewProps.t(
          viewProps.linuxLaunchOnly ? "sockscap.rootlessLockedHint" : "sockscap.lockedHint",
        )}
      >
        <Lock className="w-3.5 h-3.5 shrink-0" />
        <span className="hidden xl:block truncate">
          {viewProps.t(viewProps.linuxLaunchOnly ? "sockscap.rootlessLockedHint" : "sockscap.lockedHint")}
        </span>
      </div>
    )}
    {viewProps.tunConflicts.length > 0 && (
      <button
        type="button"
        data-testid="sockscap-tun-warning"
        className="p-1.5 rounded text-amber-600 dark:text-amber-400 bg-amber-500/10 hover:bg-amber-500/20"
        title={viewProps.t("sockscap.tunConflictWarning", { adapters: viewProps.tunConflicts.join(", ") })}
        aria-label={viewProps.t("sockscap.tunConflictTitle")}
        onClick={() => viewProps.setTunWarningOpen(true)}
      >
        <AlertTriangle className="w-4 h-4" />
      </button>
    )}
    <div className={`text-[11px] font-medium ${phaseTone(viewProps.status?.phase ?? "idle")}`}>
      {viewProps.status ? viewProps.t(`sockscap.phase.${viewProps.status.phase}`) : viewProps.t("sockscap.phase.idle")}
    </div>
    {viewProps.busy && <Loader2 className="w-4 h-4 animate-spin text-[var(--taomni-text-muted)]" />}
    {viewProps.running ? (
      <button
        type="button"
        data-testid="sockscap-stop"
        className="inline-flex items-center gap-1 px-3 py-1.5 rounded text-[12px] bg-red-600/90 text-white hover:bg-red-600"
        onClick={() => void viewProps.onStop()}
        disabled={viewProps.busy}
      >
        <Square className="w-3.5 h-3.5" />
        {viewProps.t("sockscap.stop")}
      </button>
    ) : !viewProps.linuxLaunchOnly ? (
      <button
        type="button"
        ref={viewProps.startButtonRef}
        data-testid="sockscap-start"
        className="inline-flex items-center gap-1 px-3 py-1.5 rounded text-[12px] bg-[var(--taomni-accent)] text-white hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed"
        onClick={() => void viewProps.preflightAndStart()}
        disabled={viewProps.busy || viewProps.probing || viewProps.redirectorApprovalWaiting}
        title={
          viewProps.redirectorApprovalWaiting
            ? viewProps.t("sockscap.redirectorApprovalPendingHint")
            : undefined
        }
      >
        {viewProps.probing ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Play className="w-3.5 h-3.5" />
        )}
        {viewProps.probing ? viewProps.t("sockscap.probing") : viewProps.t("sockscap.start")}
      </button>
    ) : null}
    {viewProps.caps?.platform === "macos" && (
      <button
        type="button"
        data-testid="sockscap-macos-setup-help"
        className="inline-flex items-center gap-1 px-2 py-1.5 rounded text-[12px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
        onClick={() => {
          viewProps.setMacosSetupError(null);
          viewProps.setMacosSetupGuideMode("help");
        }}
        title={viewProps.t("sockscap.macosSetupHelpHint")}
        aria-label={viewProps.t("sockscap.macosSetupHelp")}
      >
        <HelpCircle className="w-3.5 h-3.5" />
        <span>{viewProps.t("sockscap.macosSetupHelp")}</span>
      </button>
    )}
    <button
      type="button"
      data-testid="sockscap-refresh-status"
      className="inline-flex items-center gap-1 px-2 py-1.5 rounded text-[12px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
      onClick={() => void viewProps.onRefreshStatus()}
      disabled={viewProps.busy}
      title={viewProps.t("sockscap.refreshStatus")}
    >
      <RefreshCw className={`w-3.5 h-3.5 ${viewProps.busy ? "animate-spin" : ""}`} />
    </button>
    <button
      type="button"
      data-testid="sockscap-recover"
      className="inline-flex items-center gap-1 px-2 py-1.5 rounded text-[12px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] text-[var(--taomni-text-muted)]"
      onClick={() => void viewProps.onRecover()}
      disabled={viewProps.busy}
      title={viewProps.t("sockscap.recoverHint")}
    >
      {viewProps.t("sockscap.recover")}
    </button>
    {viewProps.onClose && (
      <button
        type="button"
        className="p-1.5 rounded hover:bg-[var(--taomni-hover)]"
        onClick={viewProps.onClose}
        aria-label={viewProps.t("common.close")}
      >
        <X className="w-4 h-4" />
      </button>
    )}
  </div>);
}
