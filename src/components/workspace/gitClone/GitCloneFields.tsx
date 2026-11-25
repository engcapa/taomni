import { Eye, EyeOff, FolderOpen, RefreshCw } from "lucide-react";
import { useId } from "react";
import { useT } from "../../../lib/i18n";
import type { GitCloneDefaults } from "../../../lib/gitClone";
import {
  cloneDestination,
  type GitCloneFormErrors,
  type GitCloneFormState,
} from "./gitCloneForm";

export interface GitCloneFieldsProps {
  form: GitCloneFormState;
  errors: GitCloneFormErrors;
  defaults: GitCloneDefaults | null;
  branchOptions: string[];
  probing: boolean;
  probeError: string | null;
  disabled: boolean;
  onChange: (patch: Partial<GitCloneFormState>) => void;
  onDetect: () => void;
  onBrowse: () => void;
}

function errorText(
  t: ReturnType<typeof useT>,
  error: string | undefined,
  prefix: string,
): string | null {
  return error ? t(`${prefix}.${error}`) : null;
}

export function GitCloneFields({
  form,
  errors,
  defaults,
  branchOptions,
  probing,
  probeError,
  disabled,
  onChange,
  onDetect,
  onBrowse,
}: GitCloneFieldsProps) {
  const t = useT();
  const branchListId = useId();
  const vaultUnlocked = defaults?.vaultState === "unlocked";
  const appProxy = defaults?.appProxyUrl ?? "";
  const appProxyReadOnly = form.proxyMode === "app";
  const appProxyError = defaults?.appProxyError;
  return (
    <div className="space-y-4">
      <section data-testid="git-clone-section-repository" className="space-y-3">
        <div>
          <label className="mb-1 block text-ui-small font-semibold uppercase tracking-wide text-[var(--taomni-text-muted)]" htmlFor="git-clone-url">
            {t("gitClone.url")}
          </label>
          <input
            id="git-clone-url"
            data-testid="workspace-git-clone-url"
            className="taomni-input h-8 w-full"
            aria-label={t("gitClone.url")}
            aria-invalid={Boolean(errors.url)}
            placeholder={t("gitClone.urlPlaceholder")}
            value={form.url}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => onChange({ url: event.target.value })}
            onBlur={() => { if (form.url.trim() && !errors.url) onDetect(); }}
          />
          <p className="mt-1 text-ui-small text-[var(--taomni-text-muted)]">{t("gitClone.urlHint")}</p>
          {errorText(t, errors.url, "gitClone.urlErrors") && (
            <p data-testid="workspace-git-clone-url-error" role="alert" className="mt-1 text-ui-small text-red-500">
              {errorText(t, errors.url, "gitClone.urlErrors")}
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-ui-small text-[var(--taomni-text-muted)]" htmlFor="git-clone-name">
              {t("gitClone.name")}
            </label>
            <input
              id="git-clone-name"
              data-testid="workspace-git-clone-name"
              className="taomni-input h-8 w-full"
              aria-label={t("gitClone.name")}
              aria-invalid={Boolean(errors.name)}
              value={form.name}
              disabled={disabled}
              onChange={(event) => onChange({ name: event.target.value, nameTouched: true })}
            />
            {errorText(t, errors.name, "gitClone.nameErrors") && (
              <p data-testid="workspace-git-clone-name-error" role="alert" className="mt-1 text-ui-small text-red-500">
                {errorText(t, errors.name, "gitClone.nameErrors")}
              </p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-ui-small text-[var(--taomni-text-muted)]" htmlFor="git-clone-branch">
              {t("gitClone.branch")}
            </label>
            <div className="flex items-center gap-1">
              <input
                id="git-clone-branch"
                data-testid="workspace-git-clone-branch"
                className="taomni-input h-8 min-w-0 flex-1"
                aria-label={t("gitClone.branch")}
                aria-invalid={Boolean(errors.branch)}
                list={branchListId}
                placeholder={t("gitClone.branchPlaceholder")}
                value={form.branch}
                disabled={disabled}
                onChange={(event) => onChange({ branch: event.target.value, branchTouched: true })}
              />
              <datalist id={branchListId}>
                {branchOptions.map((branch) => <option key={branch} value={branch} />)}
              </datalist>
              <button
                type="button"
                data-testid="workspace-git-clone-branch-detect"
                className="taomni-btn inline-flex h-8 shrink-0 items-center gap-1 px-2"
                title={t("gitClone.branchDetect")}
                aria-label={t("gitClone.branchDetect")}
                aria-busy={probing}
                disabled={disabled || probing || !form.url.trim()}
                onClick={onDetect}
              >
                <RefreshCw className={`h-3 w-3 ${probing ? "animate-spin" : ""}`} />
                {t("gitClone.branchDetect")}
              </button>
            </div>
            {errorText(t, errors.branch, "gitClone.branchErrors") && (
              <p data-testid="workspace-git-clone-branch-error" role="alert" className="mt-1 text-ui-small text-red-500">
                {errorText(t, errors.branch, "gitClone.branchErrors")}
              </p>
            )}
            {probeError && (
              <p data-testid="workspace-git-clone-probe-error" className="mt-1 text-ui-small" style={{ color: "var(--taomni-warning, #d97706)" }}>
                {t("gitClone.branchCheckFailed", { error: probeError })}
              </p>
            )}
          </div>
        </div>

        <div>
          <label className="mb-1 block text-ui-small text-[var(--taomni-text-muted)]" htmlFor="git-clone-location">
            {t("gitClone.location")}
          </label>
          <div className="flex items-center gap-2">
            <input
              id="git-clone-location"
              data-testid="workspace-git-clone-location"
              className="taomni-input h-8 min-w-0 flex-1"
              aria-label={t("gitClone.location")}
              aria-invalid={Boolean(errors.location)}
              value={form.location}
              disabled={disabled}
              spellCheck={false}
              onChange={(event) => onChange({ location: event.target.value })}
            />
            <button
              type="button"
              data-testid="workspace-git-clone-browse"
              className="taomni-btn inline-flex h-8 shrink-0 items-center gap-1 px-2"
              disabled={disabled}
              onClick={onBrowse}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              {t("gitClone.browse")}
            </button>
          </div>
          <p className="mt-1 text-ui-small text-[var(--taomni-text-muted)]">{t("gitClone.locationHint")}</p>
          {errorText(t, errors.location, "gitClone.locationErrors") && (
            <p data-testid="workspace-git-clone-location-error" role="alert" className="mt-1 text-ui-small text-red-500">
              {errorText(t, errors.location, "gitClone.locationErrors")}
            </p>
          )}
          <p className="mt-1 truncate text-ui-small" title={cloneDestination(form)}>
            <span className="text-[var(--taomni-text-muted)]">{t("gitClone.destination")}: </span>
            <code data-testid="workspace-git-clone-destination" className="taomni-mono text-[var(--taomni-accent)]">
              {cloneDestination(form)}
            </code>
          </p>
        </div>
      </section>

      <section data-testid="git-clone-section-identity">
        <h3 className="mb-2 text-ui-small font-semibold uppercase tracking-wide text-[var(--taomni-text-muted)]">
          {t("gitClone.identity")}
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-ui-small text-[var(--taomni-text-muted)]" htmlFor="git-clone-user-name">user.name</label>
            <input
              id="git-clone-user-name"
              data-testid="workspace-git-clone-user-name"
              className="taomni-input h-8 w-full"
              aria-label="user.name"
              value={form.userName}
              disabled={disabled}
              onChange={(event) => onChange({ userName: event.target.value })}
            />
          </div>
          <div>
            <label className="mb-1 block text-ui-small text-[var(--taomni-text-muted)]" htmlFor="git-clone-user-email">user.email</label>
            <input
              id="git-clone-user-email"
              data-testid="workspace-git-clone-user-email"
              className="taomni-input h-8 w-full"
              aria-label="user.email"
              value={form.userEmail}
              disabled={disabled}
              onChange={(event) => onChange({ userEmail: event.target.value })}
            />
          </div>
        </div>
        <p className="mt-1 text-ui-small text-[var(--taomni-text-muted)]">{t("gitClone.identityHint")}</p>
      </section>

      <section data-testid="git-clone-section-proxy">
        <h3 className="mb-2 text-ui-small font-semibold uppercase tracking-wide text-[var(--taomni-text-muted)]">
          {t("gitClone.proxy")}
        </h3>
        <div className="flex flex-wrap items-center gap-4 text-ui-body" role="radiogroup" aria-label={t("gitClone.proxy")}>
          {(["app", "custom", "none"] as const).map((mode) => (
            <label key={mode} className="inline-flex items-center gap-1.5">
              <input
                type="radio"
                name="git-clone-proxy-mode"
                data-testid={`workspace-git-clone-proxy-${mode}`}
                value={mode}
                checked={form.proxyMode === mode}
                disabled={disabled || (mode === "app" && (!defaults?.appProxyEnabled || !appProxy))}
                onChange={() => onChange({ proxyMode: mode })}
              />
              {t(`gitClone.proxyMode.${mode}`)}
            </label>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-ui-small text-[var(--taomni-text-muted)]" htmlFor="git-clone-http-proxy">http.proxy</label>
            <input
              id="git-clone-http-proxy"
              data-testid="workspace-git-clone-http-proxy"
              className="taomni-input h-8 w-full"
              aria-label="http.proxy"
              value={appProxyReadOnly ? appProxy : form.httpProxy}
              readOnly={appProxyReadOnly}
              disabled={disabled || form.proxyMode === "none"}
              onChange={(event) => onChange({ httpProxy: event.target.value })}
            />
          </div>
          <div>
            <label className="mb-1 block text-ui-small text-[var(--taomni-text-muted)]" htmlFor="git-clone-https-proxy">https.proxy</label>
            <input
              id="git-clone-https-proxy"
              data-testid="workspace-git-clone-https-proxy"
              className="taomni-input h-8 w-full"
              aria-label="https.proxy"
              value={appProxyReadOnly ? appProxy : form.httpsProxy}
              readOnly={appProxyReadOnly}
              disabled={disabled || form.proxyMode === "none"}
              onChange={(event) => onChange({ httpsProxy: event.target.value })}
            />
          </div>
        </div>
        <p data-testid="workspace-git-clone-proxy-hint" className="mt-1 text-ui-small text-[var(--taomni-text-muted)]">
          {form.proxyMode === "app" ? t("gitClone.proxyHintApp") : form.proxyMode === "none" ? t("gitClone.proxyHintNone") : t("gitClone.proxyHintCustom")}
        </p>
        {appProxyError && (
          <p data-testid="workspace-git-clone-proxy-error" className="mt-1 text-ui-small" style={{ color: "var(--taomni-warning, #d97706)" }}>
            {t("gitClone.appProxyUnavailable", { error: appProxyError })}
          </p>
        )}
        {form.proxyMode === "custom" && errorText(t, errors.proxy, "gitClone.proxyErrors") && (
          <p data-testid="workspace-git-clone-proxy-invalid" role="alert" className="mt-1 text-ui-small text-red-500">
            {errorText(t, errors.proxy, "gitClone.proxyErrors")}
          </p>
        )}
      </section>

      <section data-testid="git-clone-section-auth">
        <h3 className="mb-2 text-ui-small font-semibold uppercase tracking-wide text-[var(--taomni-text-muted)]">
          {t("gitClone.authentication")}
        </h3>
        <div className="grid grid-cols-[1fr_auto_180px] items-end gap-2">
          <div>
            <label className="mb-1 block text-ui-small text-[var(--taomni-text-muted)]" htmlFor="git-clone-token">{t("gitClone.token")}</label>
            <input
              id="git-clone-token"
              data-testid="workspace-git-clone-token"
              className="taomni-input h-8 w-full"
              aria-label={t("gitClone.token")}
              type={form.showToken ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              placeholder={t("gitClone.tokenPlaceholder")}
              value={form.token}
              disabled={disabled}
              onChange={(event) => onChange({ token: event.target.value, useSavedToken: event.target.value ? false : form.useSavedToken })}
            />
          </div>
          <button
            type="button"
            data-testid="workspace-git-clone-token-visibility"
            className="taomni-btn inline-flex h-8 items-center gap-1 px-2"
            aria-pressed={form.showToken}
            aria-label={form.showToken ? t("gitClone.hideToken") : t("gitClone.showToken")}
            disabled={disabled}
            onClick={() => onChange({ showToken: !form.showToken })}
          >
            {form.showToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {form.showToken ? t("gitClone.hideToken") : t("gitClone.showToken")}
          </button>
          <div>
            <label className="mb-1 block text-ui-small text-[var(--taomni-text-muted)]" htmlFor="git-clone-token-username">{t("gitClone.tokenUsername")}</label>
            <input
              id="git-clone-token-username"
              data-testid="workspace-git-clone-token-username"
              className="taomni-input h-8 w-full"
              aria-label={t("gitClone.tokenUsername")}
              value={form.tokenUsername}
              disabled={disabled}
              onChange={(event) => onChange({ tokenUsername: event.target.value })}
            />
          </div>
        </div>
        <p className="mt-1 text-ui-small text-[var(--taomni-text-muted)]">{t("gitClone.tokenHint")}</p>
        <div className="mt-2 space-y-1 text-ui-body">
          {defaults?.savedTokenAvailable && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid="workspace-git-clone-use-saved-token"
                checked={form.useSavedToken}
                disabled={disabled}
                onChange={(event) => onChange({ useSavedToken: event.target.checked })}
              />
              {t("gitClone.useSavedToken")}
            </label>
          )}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              data-testid="workspace-git-clone-remember-token"
              checked={form.rememberToken}
              disabled={disabled || !vaultUnlocked}
              onChange={(event) => onChange({ rememberToken: event.target.checked })}
            />
            {t("gitClone.rememberToken")}
          </label>
          {!vaultUnlocked && (
            <p data-testid="workspace-git-clone-vault-hint" className="text-ui-small text-[var(--taomni-text-muted)]">
              {t("gitClone.vaultLocked")}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
