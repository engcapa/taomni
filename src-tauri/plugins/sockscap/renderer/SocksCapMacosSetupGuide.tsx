import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { ModalSurface } from "../../../crates/taomni-plugin-api/frontend/ui/ModalSurface";
import {
  CheckCircle2,
  HelpCircle,
  Loader2,
  Play,
  RefreshCw,
  Shield,
  X,
} from "lucide-react";
import { useT } from "../../../../src/lib/i18n";
import type { RedirectorInstallStatus } from "../../../../src/lib/sockscap";

type GuideMode = "onboarding" | "help";

interface Props {
  mode: GuideMode;
  installStatus: RedirectorInstallStatus | null;
  captureReady: boolean;
  completed: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onInstall: () => void;
  onRefreshApproval: () => void;
  onContinueToStart: () => void;
}

type StepState = "done" | "current" | "upcoming";

function statusSummaryKey(status: RedirectorInstallStatus | null): string {
  if (!status) return "sockscap.macosSetupStatusChecking";
  if (status.state === "missing") return "sockscap.macosSetupStatusMissing";
  if (status.state === "upgradeAvailable") return "sockscap.macosSetupStatusUpgrade";
  if (status.state === "resourceMissing") return "sockscap.macosSetupStatusResourceMissing";
  if (status.state === "conflict") return "sockscap.macosSetupStatusConflict";
  if (status.systemExtensionState === "waitingForUser") {
    return "sockscap.macosSetupStatusWaiting";
  }
  if (status.systemExtensionState === "notRegistered") {
    return "sockscap.macosSetupStatusNotRegistered";
  }
  if (status.systemExtensionState === "enabled") {
    return "sockscap.macosSetupStatusEnabled";
  }
  return "sockscap.macosSetupStatusUnknown";
}

function StepMarker({ index, state }: { index: number; state: StepState }) {
  if (state === "done") {
    return <CheckCircle2 className="w-5 h-5 shrink-0 text-ui-success" />;
  }
  return (
    <span
      className={`w-5 h-5 shrink-0 rounded-full inline-flex items-center justify-center text-ui-caption font-semibold border ${
        state === "current"
          ? "border-[var(--taomni-accent)] bg-[var(--taomni-primary-bg)] text-[var(--taomni-primary-text)]"
          : "border-[var(--taomni-divider)] text-[var(--taomni-text-muted)]"
      }`}
    >
      {index}
    </span>
  );
}

export function SocksCapMacosSetupGuide({
  mode,
  installStatus,
  captureReady,
  completed,
  busy,
  error,
  onClose,
  onInstall,
  onRefreshApproval,
  onContinueToStart,
}: Props) {
  const t = useT();
  const backdropPointer = useRef<number | null>(null);
  function onBackdrop(event: ReactPointerEvent<HTMLDialogElement>) {
    if (event.target !== event.currentTarget) return false;
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientX < box.left || event.clientX >= box.right || event.clientY < box.top || event.clientY >= box.bottom;
  }

  const installed =
    installStatus?.state === "pendingSystemApproval" || installStatus?.state === "ready";
  const activationRequested =
    installStatus?.systemExtensionState === "waitingForUser" ||
    installStatus?.systemExtensionState === "other" ||
    installStatus?.systemExtensionState === "enabled";
  const approvalGranted = installStatus?.systemExtensionState === "enabled";
  const setupComplete = completed || captureReady;

  const stepStates: StepState[] = [
    installed ? "done" : "current",
    activationRequested ? "done" : installed ? "current" : "upcoming",
    approvalGranted ? "done" : activationRequested ? "current" : "upcoming",
    setupComplete ? "done" : approvalGranted ? "current" : "upcoming",
  ];

  const canInstall =
    !!installStatus?.resourceAvailable &&
    installStatus.state !== "conflict" &&
    installStatus.state !== "resourceMissing";
  const primary = !installStatus
    ? "checking"
    : !installed
      ? "install"
      : !activationRequested
        ? "start"
        : !approvalGranted
          ? "refresh"
          : !setupComplete
            ? "start"
            : "close";

  const steps = [
    {
      title: t("sockscap.macosSetupStep1Title"),
      body: t("sockscap.macosSetupStep1Body"),
    },
    {
      title: t("sockscap.macosSetupStep2Title"),
      body: t("sockscap.macosSetupStep2Body"),
    },
    {
      title: t("sockscap.macosSetupStep3Title"),
      body: t("sockscap.macosSetupStep3Body"),
    },
    {
      title: t("sockscap.macosSetupStep4Title"),
      body: t("sockscap.macosSetupStep4Body"),
    },
  ];

  return createPortal(
    <ModalSurface
      aria-labelledby="sockscap-macos-setup-title"
      data-testid="sockscap-macos-setup-dialog"
      initialFocus='[data-testid="sockscap-macos-setup-install"], [data-testid="sockscap-macos-setup-refresh"], [data-testid="sockscap-macos-setup-continue"], [data-testid="sockscap-macos-setup-finish"], [data-testid="sockscap-macos-setup-close"]'
      onCancel={() => { if (!busy) onClose(); }}
      onPointerDown={(event) => {
        backdropPointer.current = !busy && event.button === 0 && onBackdrop(event) ? event.pointerId : null;
      }}
      onPointerCancel={() => { backdropPointer.current = null; }}
      onPointerUp={(event) => {
        const dismiss = !busy && backdropPointer.current === event.pointerId && onBackdrop(event);
        backdropPointer.current = null;
        if (dismiss) onClose();
      }}
      className="taomni-sockscap-popover m-auto w-[min(620px,94vw)] max-h-[86vh] max-w-none p-0 open:flex flex-col rounded-xl bg-[var(--taomni-panel-bg)] text-[var(--taomni-text)] border border-[var(--taomni-divider)] shadow-2xl backdrop:bg-[var(--taomni-overlay)]"
    >
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--taomni-divider)]">
          {mode === "onboarding" ? (
            <Shield className="w-5 h-5 shrink-0 text-[var(--taomni-accent)]" />
          ) : (
            <HelpCircle className="w-5 h-5 shrink-0 text-[var(--taomni-accent)]" />
          )}
          <div className="min-w-0 flex-1">
            <h2 id="sockscap-macos-setup-title" className="text-ui-title font-semibold">
              {t(
                mode === "onboarding"
                  ? "sockscap.macosSetupTitle"
                  : "sockscap.macosSetupHelpTitle",
              )}
            </h2>
            <p className="mt-0.5 text-ui-small text-[var(--taomni-text-muted)]">
              {t("sockscap.macosSetupIntro")}
            </p>
          </div>
          <button
            type="button"
            data-testid="sockscap-macos-setup-close"
            className="p-1.5 rounded text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)] disabled:opacity-50"
            aria-label={t("common.close")}
            disabled={busy}
            onClick={onClose}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="min-h-0 flex-auto overflow-auto px-4 py-3">
          <div
            data-testid="sockscap-macos-setup-status"
            data-installer-source={installStatus?.resourceSource ?? undefined}
            className="mb-3 flex items-start gap-2 rounded-lg border border-ui-info-border bg-ui-info-surface px-3 py-2 text-ui-small text-ui-info"
          >
            {busy ? (
              <Loader2 className="mt-0.5 w-3.5 h-3.5 shrink-0 animate-spin" />
            ) : (
              <Shield className="mt-0.5 w-3.5 h-3.5 shrink-0" />
            )}
            <div>
              <span className="font-semibold">{t("sockscap.macosSetupCurrentStatus")}</span>{" "}
              {t(statusSummaryKey(installStatus))}
              {installStatus?.packageVersion && (
                <span className="ml-1 font-mono">v{installStatus.packageVersion}</span>
              )}
            </div>
          </div>

          <ol className="space-y-2.5">
            {steps.map((step, index) => (
              <li
                key={step.title}
                data-testid={`sockscap-macos-setup-step-${index + 1}`}
                className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 ${
                  stepStates[index] === "current"
                    ? "border-[var(--taomni-accent)]/50 bg-[var(--taomni-accent)]/5"
                    : "border-[var(--taomni-divider)]"
                }`}
              >
                <StepMarker index={index + 1} state={stepStates[index]} />
                <div className="min-w-0">
                  <div className="text-ui-body font-semibold">{step.title}</div>
                  <div className="mt-1 text-ui-small leading-5 text-[var(--taomni-text-muted)]">
                    {step.body}
                  </div>
                  {index === 2 && (
                    <div className="mt-1.5 inline-flex rounded bg-[var(--taomni-bg)] px-2 py-1 font-mono text-ui-caption text-[var(--taomni-text)] border border-[var(--taomni-divider)]">
                      {t("sockscap.macosSetupPrivacyPath")}
                    </div>
                  )}
                  {index === 3 && (
                    <div className="mt-1.5 text-ui-caption text-[var(--taomni-text-muted)]">
                      {t("sockscap.macosSetupNetworkPath")}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>

          {error && (
            <div
              data-testid="sockscap-macos-setup-error"
              className="mt-3 rounded-lg border border-ui-danger-border bg-ui-danger-surface px-3 py-2 text-ui-small text-ui-danger break-words"
            >
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--taomni-divider)]">
          <button
            type="button"
            className="px-3 py-1.5 rounded text-ui-body border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] disabled:opacity-50"
            disabled={busy}
            onClick={onClose}
          >
            {mode === "onboarding" && !setupComplete
              ? t("sockscap.macosSetupLater")
              : t("common.close")}
          </button>

          {primary === "install" && (
            <button
              type="button"
              data-testid="sockscap-macos-setup-install"
              data-primary="true"
              className="taomni-btn inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-ui-body"
              disabled={busy || !canInstall}
              onClick={onInstall}
            >
              {busy ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Shield className="w-3.5 h-3.5" />
              )}
              {t("sockscap.installRedirector")}
            </button>
          )}

          {primary === "refresh" && (
            <button
              type="button"
              data-testid="sockscap-macos-setup-refresh"
              data-primary="true"
              className="taomni-btn inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-ui-body"
              disabled={busy}
              onClick={onRefreshApproval}
            >
              {busy ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              {t("sockscap.macosSetupRefreshNow")}
            </button>
          )}

          {primary === "start" && (
            <button
              type="button"
              data-testid="sockscap-macos-setup-continue"
              data-primary="true"
              className="taomni-btn inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-ui-body"
              disabled={busy}
              onClick={onContinueToStart}
            >
              <Play className="w-3.5 h-3.5" />
              {t("sockscap.macosSetupGoToStart")}
            </button>
          )}

          {primary === "close" && (
            <button
              type="button"
              data-testid="sockscap-macos-setup-finish"
              data-primary="true"
              className="taomni-btn inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-ui-body"
              onClick={onClose}
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              {t("sockscap.macosSetupFinished")}
            </button>
          )}
        </div>
    </ModalSurface>,
    document.body,
  );
}

