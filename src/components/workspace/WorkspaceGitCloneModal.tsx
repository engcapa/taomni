import { Button } from "../ui/Button";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { selectFolderPath } from "../../lib/ipc";
import {
  gitCloneProbe,
  type GitCloneProbeResult,
} from "../../lib/gitClone";
import { useGitCloneStore } from "../../stores/gitCloneStore";
import { useFocusReturn } from "../editor/workspace/useFocusReturn";
import { GitCloneFields } from "./gitClone/GitCloneFields";
import { GitCloneProgressView } from "./gitClone/GitCloneProgressView";
import {
  autoNameForUrl,
  cloneDestination,
  cloneRequestFromForm,
  detectedBranchFor,
  hasCloneFormErrors,
  initialCloneForm,
  validateCloneForm,
  withProxyMode,
  type GitCloneFormState,
} from "./gitClone/gitCloneForm";

export function WorkspaceGitCloneModal() {
  const t = useT();
  const open = useGitCloneStore((state) => state.open);
  const defaults = useGitCloneStore((state) => state.defaults);
  const defaultsStatus = useGitCloneStore((state) => state.defaultsStatus);
  const defaultsError = useGitCloneStore((state) => state.defaultsError);
  const task = useGitCloneStore((state) => state.task);
  const closeDialog = useGitCloneStore((state) => state.closeDialog);
  const startClone = useGitCloneStore((state) => state.startClone);
  const cancelClone = useGitCloneStore((state) => state.cancelClone);
  const resetTask = useGitCloneStore((state) => state.resetTask);
  const loadDefaults = useGitCloneStore((state) => state.loadDefaults);

  const [form, setForm] = useState<GitCloneFormState>(() => initialCloneForm(null));
  const [submitted, setSubmitted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [branchOptions, setBranchOptions] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const probeGeneration = useRef(0);
  const defaultsKey = useRef<string | null>(null);
  useFocusReturn(open);

  const focusUrl = useCallback(() => {
    dialogRef.current
      ?.querySelector<HTMLElement>('[data-testid="workspace-git-clone-url"]')
      ?.focus();
  }, []);

  const active = Boolean(task && !["completed", "failed", "cancelled"].includes(task.phase));

  useEffect(() => {
    if (!open || !defaults) return;
    const key = JSON.stringify(defaults);
    if (defaultsKey.current === key) return;
    defaultsKey.current = key;
    setForm((previous) => {
      const next = initialCloneForm(defaults);
      return {
        ...next,
        url: previous.url,
        name: previous.name,
        nameTouched: previous.nameTouched,
        branch: previous.branchTouched ? previous.branch : next.branch,
        branchTouched: previous.branchTouched,
        token: previous.token,
        showToken: previous.showToken,
        proxyMode: previous.proxyMode === "custom" ? "custom" : next.proxyMode,
        httpProxy: previous.proxyMode === "custom" ? previous.httpProxy : next.httpProxy,
        httpsProxy: previous.proxyMode === "custom" ? previous.httpsProxy : next.httpsProxy,
      };
    });
  }, [open, defaults]);

  useEffect(() => {
    if (!open) return;
    setFormError(null);
    setSubmitted(false);
    const timer = window.setTimeout(() => focusUrl(), 0);
    return () => window.clearTimeout(timer);
  }, [focusUrl, open]);

  const patchForm = useCallback((patch: Partial<GitCloneFormState>) => {
    setForm((previous) => {
      let next = { ...previous, ...patch };
      if ("proxyMode" in patch && patch.proxyMode) {
        next = withProxyMode(next, patch.proxyMode, defaults);
        next.proxyMode = patch.proxyMode;
      }
      if ("url" in patch) {
        next = autoNameForUrl(next);
      }
      return next;
    });
    if ("url" in patch || "proxyMode" in patch || "token" in patch) {
      setProbeError(null);
    }
    if ("url" in patch) {
      // Invalidate an in-flight branch probe so a late response cannot replace
      // the branch for a URL the user has already changed.
      probeGeneration.current += 1;
      setProbing(false);
    }
  }, [defaults]);

  const runProbe = useCallback(async () => {
    setProbeError(null);
    if (!form.url.trim()) return;
    const generation = ++probeGeneration.current;
    setProbing(true);
    try {
      const result: GitCloneProbeResult = await gitCloneProbe({
        url: form.url.trim(),
        proxyMode: form.proxyMode,
        httpProxy: form.httpProxy.trim() || null,
        httpsProxy: form.httpsProxy.trim() || null,
        token: form.token.trim() || null,
        tokenUsername: form.tokenUsername.trim() || null,
        useSavedToken: form.useSavedToken,
      });
      if (generation !== probeGeneration.current) return;
      setBranchOptions(result.branches);
      setForm((previous) => detectedBranchFor(previous, result.defaultBranch));
      if (result.defaultBranch) {
        setProbeError(null);
      }
    } catch (cause) {
      if (generation !== probeGeneration.current) return;
      setProbeError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation === probeGeneration.current) setProbing(false);
    }
  }, [form]);

  const browse = useCallback(async () => {
    if (picking) return;
    setPicking(true);
    try {
      const selected = await selectFolderPath(form.location.trim() || defaults?.cloneRoot);
      if (selected) patchForm({ location: selected });
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPicking(false);
    }
  }, [defaults?.cloneRoot, form.location, patchForm, picking]);

  const errors = validateCloneForm(form, defaults);

  const submit = useCallback(async () => {
    setSubmitted(true);
    setFormError(null);
    const currentErrors = validateCloneForm(form, defaults);
    if (hasCloneFormErrors(currentErrors)) return;
    try {
      await startClone(cloneRequestFromForm(form));
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [defaults, form, startClone]);

  const retry = useCallback(async () => {
    resetTask();
    await submit();
  }, [resetTask, submit]);

  const createAnother = useCallback(() => {
    resetTask();
    setSubmitted(false);
    setFormError(null);
    setProbeError(null);
    setBranchOptions([]);
    setForm(initialCloneForm(defaults));
    window.setTimeout(() => focusUrl(), 0);
  }, [defaults, focusUrl, resetTask]);

  if (!open) return null;

  const title = t("gitClone.title");
  const showForm = !task;
  const terminal = Boolean(task && !active);
  const completed = task?.phase === "completed";
  let primaryAction: { label: string; testId: string; onClick: () => void; kind: "primary" | "danger" | "secondary" };
  if (terminal) {
    primaryAction = completed
      ? { label: t("gitClone.createAnother"), testId: "workspace-git-clone-another", onClick: createAnother, kind: "secondary" }
      : { label: t("gitClone.retry"), testId: "workspace-git-clone-retry", onClick: () => void retry(), kind: "primary" };
  } else if (active) {
    primaryAction = { label: t("gitClone.cancelClone"), testId: "workspace-git-clone-cancel", onClick: () => void cancelClone(), kind: "danger" };
  } else {
    primaryAction = { label: t("gitClone.clone"), testId: "workspace-git-clone-start", onClick: () => void submit(), kind: "primary" };
  }

  return (
    <div
      className="fixed inset-0 taomni-dialog-backdrop flex items-center justify-center p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeDialog();
      }}
    >
      <div
        ref={dialogRef}
        data-testid="workspace-git-clone-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-labelledby="workspace-git-clone-title"
        className="flex max-h-[calc(100vh-48px)] w-[640px] max-w-[calc(100vw-24px)] flex-col rounded-xl border shadow-2xl"
        style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-panel-bg)" }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.stopPropagation();
            closeDialog();
          }
          if (event.key === "Tab") {
            const nodes = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
              "input:not(:disabled),button:not(:disabled),[tabindex]:not([tabindex='-1'])",
            ) ?? []);
            if (!nodes.length) return;
            if (event.shiftKey && document.activeElement === nodes[0]) {
              event.preventDefault();
              nodes.at(-1)?.focus();
            } else if (!event.shiftKey && document.activeElement === nodes.at(-1)) {
              event.preventDefault();
              nodes[0]?.focus();
            }
          }
        }}
      >
        <header className="shrink-0 border-b px-4 py-3" style={{ borderColor: "var(--taomni-divider)" }}>
          <h2 id="workspace-git-clone-title" className="text-ui-title font-semibold text-[var(--taomni-text)]">{title}</h2>
          <p className="mt-0.5 text-ui-small text-[var(--taomni-text-muted)]">{t("gitClone.subtitle")}</p>
        </header>

        <div data-testid="workspace-git-clone-body" className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {showForm && (
            <>
              {defaultsStatus === "error" && (
                <div data-testid="workspace-git-clone-defaults-error" role="alert" className="mb-3 flex items-center justify-between gap-2 rounded border px-3 py-2 text-ui-small"
                  style={{ borderColor: "var(--taomni-danger, #ef4444)" }}>
                  <span className="min-w-0 break-words">{t("gitClone.defaultsFailed", { error: defaultsError ?? "" })}</span>
                  <button type="button" className="taomni-btn h-6 shrink-0 px-2" onClick={() => void loadDefaults(true)}>
                    {t("gitClone.retry")}
                  </button>
                </div>
              )}
              {defaults && !defaults.gitAvailable && (
                <div data-testid="workspace-git-clone-git-missing" role="alert" className="mb-3 rounded border px-3 py-2 text-ui-small"
                  style={{ borderColor: "var(--taomni-warning-text, #d97706)" }}>
                  {t("gitClone.gitUnavailable")}
                </div>
              )}
              <GitCloneFields
                form={form}
                errors={submitted ? errors : {}}
                defaults={defaults}
                branchOptions={branchOptions}
                probing={probing}
                probeError={probeError}
                disabled={active || picking || defaultsStatus === "loading"}
                onChange={patchForm}
                onDetect={() => void runProbe()}
                onBrowse={() => void browse()}
              />
              {formError && (
                <p data-testid="workspace-git-clone-form-error" role="alert" className="mt-3 break-words text-ui-small text-ui-danger">{formError}</p>
              )}
              <p data-testid="workspace-git-clone-destination-path" className="sr-only">{cloneDestination(form)}</p>
            </>
          )}
          {task && <GitCloneProgressView task={task} />}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t px-4 py-3" style={{ borderColor: "var(--taomni-divider)" }}>
          {defaultsStatus === "loading" && showForm && (
            <span data-testid="workspace-git-clone-loading" className="mr-auto inline-flex items-center gap-1 text-ui-small text-[var(--taomni-text-muted)]">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("gitClone.loadingDefaults")}
            </span>
          )}
          <button
            type="button"
            data-testid="workspace-git-clone-close"
            className="taomni-btn h-8 px-3"
            onClick={closeDialog}
          >
            {t("gitClone.close")}
          </button>
          <Button
            type="button"
            data-testid={primaryAction.testId}
            className="h-8 px-3"
            variant={primaryAction.kind === "secondary" ? "default" : primaryAction.kind}
            disabled={picking || (showForm && defaultsStatus === "loading")}
            onClick={primaryAction.onClick}
          >
            {primaryAction.label}
          </Button>
        </footer>
      </div>
    </div>
  );
}
