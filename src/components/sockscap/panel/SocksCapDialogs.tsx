import { AlertCircle, AlertTriangle, CheckCircle2, Copy, X } from "lucide-react";
import { type AppSelector, type ProcessInfo, type SocksCapConfig } from "../../../lib/sockscap";
import { type UpstreamConfigIssue } from "../../../lib/sockscapPreflight";
import { SocksCapRootPrompt } from "../SocksCapRootPrompt";
import { SocksCapMacosSetupGuide } from "../SocksCapMacosSetupGuide";
import { useT } from "../../../lib/i18n";
import { useSocksCapRuntime } from "./useSocksCapRuntime";

export interface SocksCapDialogsProps {
  runtime: ReturnType<typeof useSocksCapRuntime>;
  busy: boolean;
  installRedirector: () => Promise<void>;
  refreshRedirectorApproval: () => Promise<void>;
  continueMacosSetupToStart: () => void;
  showProcPicker: boolean;
  t: ReturnType<typeof useT>;
  setShowProcPicker: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  processes: ProcessInfo[];
  addAppPath: (path: string, name?: string) => Promise<{ app: AppSelector; config: SocksCapConfig; } | null>;
  rootPromptIntent: "start" | "recover" | null;
  onRecover: (sudoPassword?: string) => Promise<void>;
  onStart: (sudoPassword?: string, configOverride?: SocksCapConfig) => Promise<boolean>;
  setRootPromptIntent: import("react").Dispatch<import("react").SetStateAction<"start" | "recover" | null>>;
  setRootPromptError: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  rootPromptError: string | null;
  rootPromptBusy: boolean;
  configIssues: UpstreamConfigIssue[] | null;
  setConfigIssues: import("react").Dispatch<import("react").SetStateAction<UpstreamConfigIssue[] | null>>;
  probeFailures: { profileName: string; kind: string; error: string; }[] | null;
  setProbeFailures: import("react").Dispatch<import("react").SetStateAction<{ profileName: string; kind: string; error: string; }[] | null>>;
  testDetail: { title: string; body: string; } | null;
  setTestDetail: import("react").Dispatch<import("react").SetStateAction<{ title: string; body: string; } | null>>;
  copyTestDetail: () => Promise<void>;
  testCopied: boolean;
}

export function SocksCapDialogs(props: SocksCapDialogsProps) {
  const {
    runtime,
    busy,
    installRedirector,
    refreshRedirectorApproval,
    continueMacosSetupToStart,
    showProcPicker,
    t,
    setShowProcPicker,
    processes,
    addAppPath,
    rootPromptIntent,
    onRecover,
    onStart,
    setRootPromptIntent,
    setRootPromptError,
    rootPromptError,
    rootPromptBusy,
    configIssues,
    setConfigIssues,
    probeFailures,
    setProbeFailures,
    testDetail,
    setTestDetail,
    copyTestDetail,
    testCopied,
  } = props;
  return (<>{runtime.macosSetupGuideMode && runtime.caps?.platform === "macos" && (
    <SocksCapMacosSetupGuide
      mode={runtime.macosSetupGuideMode}
      installStatus={runtime.redirectorInstall}
      captureReady={runtime.status?.phase === "active" || runtime.status?.phase === "degraded"}
      completed={runtime.macosSetupCompleted}
      busy={busy}
      error={runtime.macosSetupError}
      onClose={() => runtime.setMacosSetupGuideMode(null)}
      onInstall={() => void installRedirector()}
      onRefreshApproval={() => void refreshRedirectorApproval()}
      onContinueToStart={continueMacosSetupToStart}
    />
  )}

    {showProcPicker && (
      <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-20">
        <div className="w-[min(520px,90vw)] max-h-[70vh] flex flex-col rounded-lg bg-[var(--taomni-panel-bg)] border border-[var(--taomni-divider)] shadow-xl">
          <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--taomni-divider)]">
            <div className="text-[13px] font-semibold">{t("sockscap.pickProcess")}</div>
            <button type="button" className="p-1" onClick={() => setShowProcPicker(false)}>
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 overflow-auto p-2">
            {processes.length === 0 ? (
              <div className="text-[11px] text-[var(--taomni-text-muted)] p-2">
                {t("sockscap.processesEmpty")}
              </div>
            ) : (
              processes.map((p) => (
                <button
                  key={`${p.pid}-${p.path}`}
                  type="button"
                  className="w-full text-left px-2 py-1.5 rounded text-[11px] hover:bg-[var(--taomni-hover)]"
                  onClick={() => {
                    void addAppPath(p.path || p.name, p.name);
                    setShowProcPicker(false);
                  }}
                >
                  <div className="font-medium">{p.name || p.pid}</div>
                  <div className="text-[var(--taomni-text-muted)] truncate">{p.path}</div>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    )}

    {runtime.tunWarningOpen && (
      <div
        className="absolute inset-0 bg-black/40 flex items-center justify-center z-30"
        onClick={() => runtime.setTunWarningOpen(false)}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="sockscap-tun-warning-title"
          data-testid="sockscap-tun-warning-dialog"
          className="w-[min(520px,92vw)] rounded-lg bg-[var(--taomni-panel-bg)] border border-[var(--taomni-divider)] shadow-xl"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--taomni-divider)]">
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
            <h2 id="sockscap-tun-warning-title" className="flex-1 text-[13px] font-semibold">
              {t("sockscap.tunConflictTitle")}
            </h2>
            <button
              type="button"
              data-testid="sockscap-tun-warning-close"
              className="p-1 rounded text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)]"
              aria-label={t("common.close")}
              onClick={() => runtime.setTunWarningOpen(false)}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="px-4 py-3 text-[12px] leading-5 text-[var(--taomni-text-muted)]">
            {t("sockscap.tunConflictWarning", { adapters: runtime.tunConflicts.join(", ") })}
          </p>
        </div>
      </div>
    )}

    {rootPromptIntent && (
      <SocksCapRootPrompt
        subtitle={
          rootPromptIntent === "recover"
            ? t("sockscap.rootPromptRecoverSubtitle")
            : undefined
        }
        onSubmit={(password) => {
          if (rootPromptIntent === "recover") void onRecover(password);
          else void onStart(password);
        }}
        onCancel={() => {
          setRootPromptIntent(null);
          setRootPromptError(null);
        }}
        error={rootPromptError}
        busy={rootPromptBusy}
      />
    )}

    {/* Pre-flight: an active profile's upstream is empty → cannot start. */}
    {configIssues && (
      <div
        className="absolute inset-0 bg-black/40 flex items-center justify-center z-30"
        data-testid="sockscap-config-issue-dialog"
      >
        <div className="w-[min(480px,92vw)] flex flex-col rounded-lg bg-[var(--taomni-panel-bg)] border border-[var(--taomni-divider)] shadow-xl">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--taomni-divider)]">
            <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
            <div className="text-[13px] font-semibold">
              {t("sockscap.configIssueTitle")}
            </div>
          </div>
          <div className="px-4 py-3 space-y-2 text-[12px]">
            <div className="text-[var(--taomni-text-muted)]">
              {t("sockscap.configIssueIntro")}
            </div>
            <ul className="space-y-1.5">
              {configIssues.map((iss) => (
                <li
                  key={iss.profileId}
                  className="flex items-start gap-1.5 px-2 py-1.5 rounded bg-[var(--taomni-bg)] border border-[var(--taomni-divider)]"
                >
                  <X className="w-3.5 h-3.5 text-red-500 mt-0.5 shrink-0" />
                  <span>
                    <span className="font-semibold">{iss.profileName}</span>
                    {" — "}
                    {t(`sockscap.${iss.reasonKey}`)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--taomni-divider)]">
            <button
              type="button"
              data-testid="sockscap-config-issue-ok"
              className="px-3 py-1.5 rounded text-[12px] bg-[var(--taomni-accent)] text-white hover:opacity-90"
              onClick={() => setConfigIssues(null)}
            >
              {t("common.ok")}
            </button>
          </div>
        </div>
      </div>
    )}

    {/* Pre-flight: upstream probe failed → force start or cancel. */}
    {probeFailures && (
      <div
        className="absolute inset-0 bg-black/40 flex items-center justify-center z-30"
        data-testid="sockscap-probe-fail-dialog"
      >
        <div className="w-[min(560px,92vw)] max-h-[75vh] flex flex-col rounded-lg bg-[var(--taomni-panel-bg)] border border-[var(--taomni-divider)] shadow-xl">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--taomni-divider)]">
            <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />
            <div className="text-[13px] font-semibold">
              {t("sockscap.probeFailTitle")}
            </div>
          </div>
          <div className="px-4 py-3 space-y-2 text-[12px] overflow-auto">
            <div className="text-[var(--taomni-text-muted)]">
              {t("sockscap.probeFailIntro")}
            </div>
            <ul className="space-y-1.5">
              {probeFailures.map((f, i) => (
                <li
                  key={`${f.profileName}-${i}`}
                  className="px-2 py-1.5 rounded bg-[var(--taomni-bg)] border border-[var(--taomni-divider)]"
                >
                  <div className="font-semibold flex items-center gap-1.5">
                    <span>{f.profileName}</span>
                    <span className="px-1.5 py-0.5 rounded text-[10px] uppercase bg-[var(--taomni-hover)] font-mono">
                      {f.kind}
                    </span>
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-red-500 break-words whitespace-pre-wrap">
                    {f.error}
                  </div>
                </li>
              ))}
            </ul>
            <div className="text-[11px] text-[var(--taomni-text-muted)]">
              {t("sockscap.probeFailHint")}
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--taomni-divider)]">
            <button
              type="button"
              data-testid="sockscap-probe-fail-cancel"
              className="px-3 py-1.5 rounded text-[12px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
              onClick={() => setProbeFailures(null)}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              data-testid="sockscap-probe-fail-force"
              className="px-3 py-1.5 rounded text-[12px] bg-amber-600 text-white hover:bg-amber-500"
              onClick={() => {
                setProbeFailures(null);
                void onStart();
              }}
            >
              {t("sockscap.probeFailForce")}
            </button>
          </div>
        </div>
      </div>
    )}

    {/* Full test result — status bar only shows a summary; this shows the
          complete text and lets the user copy it. */}
    {testDetail && (
      <div
        className="absolute inset-0 bg-black/40 flex items-center justify-center z-20"
        data-testid="sockscap-test-detail"
      >
        <div className="w-[min(620px,92vw)] max-h-[75vh] flex flex-col rounded-lg bg-[var(--taomni-panel-bg)] border border-[var(--taomni-divider)] shadow-xl">
          <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--taomni-divider)]">
            <div className="text-[13px] font-semibold truncate">{testDetail.title}</div>
            <button
              type="button"
              className="p-1 rounded hover:bg-[var(--taomni-hover)]"
              onClick={() => setTestDetail(null)}
              aria-label={t("common.close")}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 overflow-auto p-3">
            <pre
              data-testid="sockscap-test-detail-body"
              className="whitespace-pre-wrap break-words text-[11px] font-mono text-[var(--taomni-text)] leading-relaxed"
            >
              {testDetail.body}
            </pre>
          </div>
          <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-[var(--taomni-divider)]">
            <button
              type="button"
              data-testid="sockscap-test-detail-copy"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
              onClick={() => void copyTestDetail()}
            >
              {testCopied ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              {testCopied ? t("common.copied") : t("common.copy")}
            </button>
            <button
              type="button"
              data-testid="sockscap-test-detail-close"
              className="px-3 py-1.5 rounded text-[12px] bg-[var(--taomni-accent)] text-white hover:opacity-90"
              onClick={() => setTestDetail(null)}
            >
              {t("common.close")}
            </button>
          </div>
        </div>
      </div>
    )}
  </>);
}
