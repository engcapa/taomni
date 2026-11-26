import { AlertCircle, AlertTriangle, CheckCircle2, Copy, X } from "lucide-react";
import { Button } from "../../../../crates/taomni-plugin-api/frontend/ui/Button";
import { Modal } from "../../../../crates/taomni-plugin-api/frontend/ui/Modal";
import { type AppSelector, type ProcessInfo, type SocksCapConfig } from "../../../../../src/lib/sockscap";
import { type UpstreamConfigIssue } from "../../../../../src/lib/sockscapPreflight";
import { ElevationPasswordPrompt } from "../../../../../src/components/ElevationPasswordPrompt";
import { SocksCapMacosSetupGuide } from "../SocksCapMacosSetupGuide";
import { useT } from "../../../../../src/lib/i18n";
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
      <Modal
        testId="sockscap-proc-picker-dialog"
        title={t("sockscap.pickProcess")}
        closeLabel={t("common.close")}
        dismissOnBackdrop
        initialFocus="button"
        onCancel={() => setShowProcPicker(false)}
        footer={
          <Button onClick={() => setShowProcPicker(false)}>
            {t("common.close")}
          </Button>
        }
      >
        {processes.length === 0 ? (
          <div className="text-ui-small text-[var(--taomni-text-muted)] p-2">
            {t("sockscap.processesEmpty")}
          </div>
        ) : (
          processes.map((p) => (
            <button
              key={`${p.pid}-${p.path}`}
              type="button"
              className="w-full text-left px-2 py-1.5 rounded text-ui-small hover:bg-[var(--taomni-hover)]"
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
      </Modal>
    )}

    {runtime.tunWarningOpen && (
      <Modal
        role="alertdialog"
        testId="sockscap-tun-warning-dialog"
        title={t("sockscap.tunConflictTitle")}
        dismissOnBackdrop
        initialFocus='[data-testid="sockscap-tun-warning-close"]'
        onCancel={() => runtime.setTunWarningOpen(false)}
        footer={
          <Button data-testid="sockscap-tun-warning-close" onClick={() => runtime.setTunWarningOpen(false)}>
            {t("common.close")}
          </Button>
        }
      >
        <div className="flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-ui-warning shrink-0 mt-0.5" aria-hidden="true" />
          <p className="text-ui-body leading-5 text-[var(--taomni-text-muted)]">
            {t("sockscap.tunConflictWarning", { adapters: runtime.tunConflicts.join(", ") })}
          </p>
        </div>
      </Modal>
    )}

    {rootPromptIntent && (
      <ElevationPasswordPrompt
        subtitle={
          rootPromptIntent === "recover"
            ? t("sockscap.rootPromptRecoverSubtitle")
            : t("sockscap.rootPromptSubtitle")
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
      <Modal
        role="alertdialog"
        tone="error"
        testId="sockscap-config-issue-dialog"
        title={t("sockscap.configIssueTitle")}
        initialFocus='[data-testid="sockscap-config-issue-ok"]'
        onCancel={() => setConfigIssues(null)}
        footer={
          <Button
            variant="primary"
            data-testid="sockscap-config-issue-ok"
            onClick={() => setConfigIssues(null)}
          >
            {t("common.ok")}
          </Button>
        }
      >
        <div className="space-y-2 text-ui-body">
          <div className="flex items-center gap-2 text-[var(--taomni-text-muted)]">
            <AlertCircle className="w-4 h-4 text-ui-danger shrink-0" aria-hidden="true" />
            <span>{t("sockscap.configIssueIntro")}</span>
          </div>
          <ul className="space-y-1.5">
            {configIssues.map((iss) => (
              <li
                key={iss.profileId}
                className="flex items-start gap-1.5 px-2 py-1.5 rounded bg-[var(--taomni-bg)] border border-[var(--taomni-divider)]"
              >
                <X className="w-3.5 h-3.5 text-ui-danger mt-0.5 shrink-0" />
                <span>
                  <span className="font-semibold">{iss.profileName}</span>
                  {" — "}
                  {t(`sockscap.${iss.reasonKey}`)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </Modal>
    )}

    {/* Pre-flight: upstream probe failed → force start or cancel. */}
    {probeFailures && (
      <Modal
        role="alertdialog"
        size="wide"
        testId="sockscap-probe-fail-dialog"
        title={t("sockscap.probeFailTitle")}
        initialFocus='[data-testid="sockscap-probe-fail-cancel"]'
        onCancel={() => setProbeFailures(null)}
        footer={
          <>
            <Button
              data-testid="sockscap-probe-fail-cancel"
              onClick={() => setProbeFailures(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              data-testid="sockscap-probe-fail-force"
              className="border-ui-warning-border bg-ui-warning-surface text-ui-warning"
              onClick={() => {
                setProbeFailures(null);
                void onStart();
              }}
            >
              {t("sockscap.probeFailForce")}
            </Button>
          </>
        }
      >
        <div className="space-y-2 text-ui-body">
          <div className="flex items-center gap-2 text-[var(--taomni-text-muted)]">
            <AlertCircle className="w-4 h-4 text-ui-warning shrink-0" aria-hidden="true" />
            <span>{t("sockscap.probeFailIntro")}</span>
          </div>
          <ul className="space-y-1.5">
            {probeFailures.map((f, i) => (
              <li
                key={`${f.profileName}-${i}`}
                className="px-2 py-1.5 rounded bg-[var(--taomni-bg)] border border-[var(--taomni-divider)]"
              >
                <div className="font-semibold flex items-center gap-1.5">
                  <span>{f.profileName}</span>
                  <span className="px-1.5 py-0.5 rounded text-ui-caption uppercase bg-[var(--taomni-hover)] font-mono">
                    {f.kind}
                  </span>
                </div>
                <div className="mt-1 font-mono text-ui-small text-ui-danger break-words whitespace-pre-wrap">
                  {f.error}
                </div>
              </li>
            ))}
          </ul>
          <div className="text-ui-small text-[var(--taomni-text-muted)]">
            {t("sockscap.probeFailHint")}
          </div>
        </div>
      </Modal>
    )}

    {/* Full test result — status bar only shows a summary; this shows the
          complete text and lets the user copy it. */}
    {testDetail && (
      <Modal
        size="wide"
        testId="sockscap-test-detail"
        title={testDetail.title}
        closeLabel={t("common.close")}
        dismissOnBackdrop
        initialFocus='[data-testid="sockscap-test-detail-close"]'
        onCancel={() => setTestDetail(null)}
        footer={
          <>
            <Button
              data-testid="sockscap-test-detail-copy"
              className="inline-flex items-center gap-1.5"
              onClick={() => void copyTestDetail()}
            >
              {testCopied ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-ui-success" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              {testCopied ? t("common.copied") : t("common.copy")}
            </Button>
            <Button
              variant="primary"
              data-testid="sockscap-test-detail-close"
              onClick={() => setTestDetail(null)}
            >
              {t("common.close")}
            </Button>
          </>
        }
      >
        <pre
          data-testid="sockscap-test-detail-body"
          className="whitespace-pre-wrap break-words text-ui-small font-mono text-[var(--taomni-text)] leading-relaxed"
        >
          {testDetail.body}
        </pre>
      </Modal>
    )}
  </>);
}
