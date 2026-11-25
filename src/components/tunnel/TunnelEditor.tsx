import { IconButton } from "../ui/IconButton";
import { useEffect, useId, useMemo, useState } from "react";
import { useModalDraggable } from "../../hooks/useModalDraggable";
import { useModalShortcuts, getShortcutSuffixes } from "../../hooks/useModalShortcuts";
import {
  X,
  Save as SaveIcon,
  XCircle,
  Users,
  Monitor,
  Flame,
  Server,
  Link as LinkIcon,
  ArrowRight,
  ArrowLeft,
  Globe,
} from "lucide-react";
import type { TunnelConfig, TunnelKind } from "../../lib/tunnel";
import { firstTunnelError } from "./tunnelValidation";
import { defaultTunnel } from "../../lib/tunnel";
import type { SessionConfig } from "../../lib/ipc";
import { vaultPut, isVaultReference, isVaultLockedError } from "../../lib/ipc";
import { useVaultStore } from "../../stores/vaultStore";
import { ensureVaultReady } from "../../lib/vaultGate";
import { useT } from "../../lib/i18n";

interface Props {
  initial?: TunnelConfig;
  sessions: SessionConfig[];
  focus?: "auth";
  onSave: (config: TunnelConfig) => Promise<void> | void;
  onCancel: () => void;
}

const KIND_OPTION_KEYS: { id: TunnelKind; label: string; description: string }[] = [
  { id: "Local",   label: "tunnels.editor.kindLocal",   description: "tunnels.editor.kindLocalDesc" },
  { id: "Remote",  label: "tunnels.editor.kindRemote",  description: "tunnels.editor.kindRemoteDesc" },
  { id: "Dynamic", label: "tunnels.editor.kindDynamic", description: "tunnels.editor.kindDynamicDesc" },
];

export function TunnelEditor({ initial, sessions, focus, onSave, onCancel }: Props) {
  const t = useT();
  const [draft, setDraft] = useState<TunnelConfig>(() => initial ?? defaultTunnel("Local"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldPrefix = useId();
  const fieldId = (field: string) => `${fieldPrefix}-${field}`;
  const [invalidField, setInvalidField] = useState<string | null>(null);
  const vaultState = useVaultStore((s) => s.state);
  const refreshVault = useVaultStore((s) => s.refresh);

  useEffect(() => {
    void refreshVault().catch(() => undefined);
  }, [refreshVault]);

  useEffect(() => {
    if (initial) setDraft(initial);
  }, [initial]);

  useEffect(() => {
    if (focus === "auth") {
      // Defer one tick so the input has been mounted, then focus it.
      const id = window.setTimeout(() => {
        const el = document.getElementById("tunnel-editor-auth-data") as HTMLInputElement | null;
        el?.focus();
        el?.select?.();
      }, 50);
      return () => window.clearTimeout(id);
    }
  }, [focus]);

  const sshSessionOptions = useMemo(
    () => sessions.filter((s) => s.session_type === "SSH" || s.session_type === "SFTP"),
    [sessions],
  );

  const validation = firstTunnelError(draft);
  const showFieldError = validation != null && validation.field === invalidField;

  // Reconcile the last submitted field with edits, including choosing a saved gateway.
  useEffect(() => {
    if (invalidField && !showFieldError) setInvalidField(null);
  }, [showFieldError, invalidField]);

  const update = <K extends keyof TunnelConfig>(key: K, value: TunnelConfig[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };
  const updateSsh = <K extends keyof TunnelConfig["ssh"]>(key: K, value: TunnelConfig["ssh"][K]) => {
    setDraft((prev) => ({ ...prev, ssh: { ...prev.ssh, [key]: value } }));
  };

  const pickSshSession = (id: string) => {
    if (id === "") {
      update("sshSessionId", null);
      return;
    }
    const session = sshSessionOptions.find((s) => s.id === id);
    if (!session) return;
    setDraft((prev) => ({
      ...prev,
      sshSessionId: id,
      ssh: {
        ...prev.ssh,
        host: session.host,
        port: session.port || 22,
        username: session.username ?? "",
        authMethod:
          typeof session.auth_method === "string"
            ? (session.auth_method as "Password" | "Agent")
            : "PrivateKey",
        authData:
          typeof session.auth_method === "object" && "PrivateKey" in session.auth_method
            ? session.auth_method.PrivateKey.key_path
            : prev.ssh.authData,
      },
    }));
  };

  const fieldProps = (field: string) => {
    const invalid = showFieldError && invalidField === field;
    return {
      id: fieldId(field),
      "aria-invalid": invalid || undefined,
      "aria-describedby": invalid ? fieldId("error") : undefined,
    };
  };

  const handleSave = async () => {
    if (busy) return;
    if (validation) {
      setError(null);
      setInvalidField(validation.field);
      document.getElementById(fieldId(validation.field))?.focus();
      return;
    }
    setInvalidField(null);
    setError(null);
    setBusy(true);
    try {
      let next = draft;
      // If the user wants to remember the SSH gateway password and the
      // current authData is a fresh plaintext, push it into the vault and
      // replace authData with the resulting `vault:<id>` reference.
      if (
        next.ssh.authMethod === "Password" &&
        next.ssh.saveAuth &&
        next.ssh.authData &&
        !isVaultReference(next.ssh.authData)
      ) {
        // Vault must be unlocked to encrypt. Pop the on-demand gate (set master
        // password / unlock) if it isn't; bail out if the user cancels.
        const ready = await ensureVaultReady(t("vault.gateReasonTunnel"));
        if (!ready) {
          setError(t("tunnels.editor.errVaultLocked"));
          setBusy(false);
          return;
        }
        const label = `${next.ssh.username || "user"}@${next.ssh.host || "?"}:${next.ssh.port}`;
        const result = await vaultPut("tunnel-password", label, next.ssh.authData);
        next = {
          ...next,
          ssh: { ...next.ssh, authData: result.reference },
        };
        setDraft(next);
      } else if (
        next.ssh.authMethod === "Password" &&
        !next.ssh.saveAuth &&
        next.ssh.authData &&
        isVaultReference(next.ssh.authData)
      ) {
        // User unchecked Save credentials: drop the vault reference (the
        // backend persistence layer already strips authData when save_auth
        // is false, but clear it explicitly for clarity).
        next = {
          ...next,
          ssh: { ...next.ssh, authData: null },
        };
        setDraft(next);
      }
      await onSave(next);
    } catch (err) {
      if (isVaultLockedError(err)) {
        setError(t("tunnels.editor.errVaultLocked"));
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const isRemote = draft.kind === "Remote";
  const isDynamic = draft.kind === "Dynamic";

  // Mode-specific labels (mirrors MobaSSHTunnel diagram)
  const forwardedLabel = isRemote ? t("tunnels.editor.localPort") : t("tunnels.editor.forwardedPort");
  const destLabel = isRemote ? t("tunnels.editor.bindAddress") : t("tunnels.editor.remoteServer");

  const { containerRef, handleRef } = useModalDraggable();

  useModalShortcuts({
    onCancel: onCancel,
    onSave: () => {
      void handleSave();
    },
  });

  const shortcuts = getShortcutSuffixes();

  return (
    <div className="fixed inset-0 taomni-dialog-backdrop flex items-center justify-center">
      <div
        ref={containerRef}
        data-testid="tunnel-editor"
        className="w-[940px] max-w-[96%] max-h-[92vh] flex flex-col rounded-[6px] shadow-2xl border overflow-hidden"
        style={{ background: "var(--taomni-panel-bg)", borderColor: "var(--taomni-chrome-border)", color: "var(--taomni-text)" }}
      >
        {/* Title bar */}
        <div
          ref={handleRef}
          className="h-7 flex items-center px-2 rounded-t-[5px] shrink-0 select-none"
          style={{ background: "var(--taomni-chrome-bg)", color: "var(--taomni-text)" }}
        >
          <LinkIcon className="w-3.5 h-3.5 mr-1.5" />
          <div className="text-ui-body font-semibold">{initial ? t("tunnels.editor.titleEdit") : t("tunnels.editor.titleNew")}</div>
          <IconButton
            label={t("tunnels.editor.close")}
            className="ml-auto hover:bg-[var(--taomni-control-hover)] rounded p-0.5"
            onClick={onCancel}
            type="button"
          >
            <X className="w-3.5 h-3.5" />
          </IconButton>
        </div>

        {/* Mode picker */}
        <div className="px-4 py-3 border-b shrink-0 grid grid-cols-3 gap-3" style={{ borderColor: "var(--taomni-divider)" }}>
          {KIND_OPTION_KEYS.map((opt) => (
            <label
              key={opt.id}
              className="flex items-start gap-2 cursor-pointer p-2 rounded border"
              style={{
                borderColor: draft.kind === opt.id ? "var(--taomni-accent)" : "var(--taomni-divider)",
                background: draft.kind === opt.id ? "var(--taomni-selected)" : "transparent",
              }}
            >
              <input
                name={fieldId("kind")}
                type="radio"
                className="taomni-radio mt-0.5"
                checked={draft.kind === opt.id}
                onChange={() => update("kind", opt.id)}
              />
              <div className="text-ui-body leading-tight">
                <div className="font-semibold" style={{ color: draft.kind === opt.id ? "var(--taomni-accent)" : "var(--taomni-text)" }}>
                  {t(opt.label)}
                </div>
                <div className="text-ui-small mt-0.5" style={{ color: "var(--taomni-text-muted)" }}>
                  {t(opt.description)}
                </div>
              </div>
            </label>
          ))}
        </div>

        {/* Diagram */}
        <div
          className="flex-1 min-h-0 overflow-auto px-4 py-4"
          style={{ background: "var(--taomni-bg)" }}
        >
          {/* Name / saved-session row */}
          <div className="flex items-center gap-2 mb-4">
            <label htmlFor={fieldId("name")} className="text-ui-body w-28 text-right">{t("tunnels.editor.tunnelNameRequired")}</label>
            <input
              {...fieldProps("name")}
              className="taomni-input w-64"
              placeholder={t("tunnels.editor.namePlaceholder")}
              value={draft.name}
              onChange={(e) => update("name", e.target.value)}
            />
            <label htmlFor={fieldId("sshSessionId")} className="text-ui-body w-32 text-right ml-3">{t("tunnels.editor.useSavedSession")}</label>
            <select
              id={fieldId("sshSessionId")}
              className="taomni-input w-64 appearance-none"
              value={draft.sshSessionId ?? ""}
              onChange={(e) => pickSshSession(e.target.value)}
            >
              <option value="">{t("tunnels.editor.savedNone")}</option>
              {sshSessionOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || `${s.username ?? "user"}@${s.host}`}
                </option>
              ))}
            </select>
          </div>

          {/* Diagram-style three columns */}
          <div
            className="grid items-stretch gap-3"
            style={{ gridTemplateColumns: "1fr 0.8fr 1fr" }}
          >
            {/* Left column: Local clients / My computer */}
            <DiagramCard
              icon={isRemote ? <Server className="w-7 h-7" style={{ color: "var(--taomni-text)" }} /> : <Users className="w-7 h-7" style={{ color: "var(--taomni-warning-icon)" }} />}
              title={isRemote ? t("tunnels.editor.remoteClients") : t("tunnels.editor.localClients")}
              subtitle={isRemote ? t("tunnels.editor.remoteClientsDesc") : t("tunnels.editor.localClientsDesc")}
            >
              <Field htmlFor={fieldId("listenPort")} label={forwardedLabel}>
                <input
                  className="taomni-input w-24"
                  {...fieldProps("listenPort")}
                  type="number"
                  placeholder="0"
                  value={draft.listenPort || ""}
                  onChange={(e) => update("listenPort", Number(e.target.value))}
                />
                <span className="text-ui-small ml-1" style={{ color: "var(--taomni-text-muted)" }}>
                  {isRemote ? t("tunnels.editor.serverBindHint") : t("tunnels.editor.listenHint")}
                </span>
              </Field>
              <Field htmlFor={fieldId("listenHost")} label={isRemote ? t("tunnels.editor.bindAddress") : t("tunnels.editor.listenAddress")}>
                <input
                  className="taomni-input w-32"
                  id={fieldId("listenHost")}
                  placeholder={isRemote ? "0.0.0.0" : "127.0.0.1"}
                  value={draft.listenHost}
                  onChange={(e) => update("listenHost", e.target.value)}
                />
              </Field>
              {isRemote && (
                <div className="text-ui-small mt-2" style={{ color: "var(--taomni-text-muted)" }}>
                  {t("tunnels.editor.remoteListenNote")}
                </div>
              )}
              <div className="flex items-center justify-end mt-2">
                <ArrowRight className="w-5 h-5" style={{ color: "var(--taomni-accent)" }} />
              </div>
            </DiagramCard>

            {/* Middle column: SSH tunnel through firewall */}
            <DiagramCard
              icon={<Flame className="w-7 h-7" style={{ color: "var(--taomni-warning-icon)" }} />}
              title={t("tunnels.editor.sshTunnelTitle")}
              subtitle={t("tunnels.editor.sshTunnelDesc")}
            >
              <Field htmlFor={fieldId("host")} label={t("tunnels.editor.sshServerRequired")}>
                <input
                  className="taomni-input w-44"
                  {...fieldProps("host")}
                  placeholder="ssh.example.com"
                  value={draft.ssh.host}
                  onChange={(e) => updateSsh("host", e.target.value)}
                />
              </Field>
              <Field htmlFor={fieldId("username")} label={t("tunnels.editor.sshLoginRequired")}>
                <input
                  className="taomni-input w-32"
                  {...fieldProps("username")}
                  placeholder="user"
                  value={draft.ssh.username}
                  onChange={(e) => updateSsh("username", e.target.value)}
                />
              </Field>
              <Field htmlFor={fieldId("port")} label={t("tunnels.editor.sshPort")}>
                <input
                  className="taomni-input w-20"
                  type="number"
                  {...fieldProps("port")}
                  placeholder="22"
                  value={draft.ssh.port || ""}
                  onChange={(e) => updateSsh("port", Number(e.target.value))}
                />
              </Field>
              <Field htmlFor={fieldId("authMethod")} label={t("tunnels.editor.auth")}>
                <select
                  className="taomni-input w-32 appearance-none"
                  id={fieldId("authMethod")}
                  value={draft.ssh.authMethod}
                  onChange={(e) => updateSsh("authMethod", e.target.value as "Password" | "PrivateKey" | "Agent")}
                >
                  <option value="Password">{t("tunnels.editor.authPassword")}</option>
                  <option value="PrivateKey">{t("tunnels.editor.authPrivateKey")}</option>
                  <option value="Agent">{t("tunnels.editor.authAgent")}</option>
                </select>
              </Field>
              <Field htmlFor="tunnel-editor-auth-data"
                label={draft.ssh.authMethod === "PrivateKey" ? t("tunnels.editor.keyPath") : t("tunnels.editor.password")}
                disabled={draft.ssh.authMethod === "Agent"}
              >
                <input
                  id="tunnel-editor-auth-data"
                  className="taomni-input w-44"
                  type={draft.ssh.authMethod === "Password" ? "password" : "text"}
                  placeholder={
                    draft.ssh.authMethod === "PrivateKey"
                      ? t("tunnels.editor.keyPathPlaceholder")
                      : draft.ssh.authMethod === "Agent"
                        ? t("tunnels.editor.usingAgentPlaceholder")
                        : draft.ssh.authData && isVaultReference(draft.ssh.authData)
                          ? t("tunnels.editor.savedInVault")
                          : ""
                  }
                  value={
                    draft.ssh.authData && isVaultReference(draft.ssh.authData)
                      ? ""
                      : (draft.ssh.authData ?? "")
                  }
                  onChange={(e) => updateSsh("authData", e.target.value)}
                  disabled={draft.ssh.authMethod === "Agent"}
                />
              </Field>
              <Field htmlFor={fieldId("saveAuth")} label={t("tunnels.editor.vault")} disabled={draft.ssh.authMethod === "Agent"}>
                <label
                  className="flex items-center gap-1.5 text-ui-small"
                  title={
                    vaultState === "empty"
                      ? t("tunnels.editor.vaultSetupHint")
                      : undefined
                  }
                >
                  <input
                    type="checkbox"
                    className="taomni-checkbox"
                    id={fieldId("saveAuth")}
                    checked={!!draft.ssh.saveAuth}
                    onChange={(e) => updateSsh("saveAuth", e.target.checked)}
                    disabled={draft.ssh.authMethod === "Agent"}
                  />
                  {t("tunnels.editor.saveCredentials")}
                </label>
              </Field>
            </DiagramCard>

            {/* Right column: Remote/SOCKS endpoint */}
            <DiagramCard
              icon={
                isDynamic ? (
                  <Globe className="w-7 h-7" style={{ color: "var(--taomni-text)" }} />
                ) : isRemote ? (
                  <Monitor className="w-7 h-7" style={{ color: "var(--taomni-text)" }} />
                ) : (
                  <Server className="w-7 h-7" style={{ color: "var(--taomni-text)" }} />
                )
              }
              title={isDynamic ? t("tunnels.editor.socksProxy") : isRemote ? t("tunnels.editor.thisComputer") : t("tunnels.editor.remoteServer")}
              subtitle={
                isDynamic
                  ? t("tunnels.editor.socksProxyDesc")
                  : isRemote
                    ? t("tunnels.editor.thisComputerDesc")
                    : t("tunnels.editor.remoteServerDesc")
              }
            >
              <div className="flex items-center justify-start mb-1">
                <ArrowLeft className="w-5 h-5" style={{ color: "var(--taomni-accent)" }} />
              </div>
              <Field htmlFor={fieldId("destHost")}
                label={isRemote ? t("tunnels.editor.localTargetRequired") : t("tunnels.editor.remoteServerRequired", { label: destLabel })}
                disabled={isDynamic}
              >
                <input
                  className="taomni-input w-44"
                  {...fieldProps("destHost")}
                  placeholder={isRemote ? "127.0.0.1" : "db.internal"}
                  value={draft.destHost}
                  onChange={(e) => update("destHost", e.target.value)}
                  disabled={isDynamic}
                />
              </Field>
              <Field htmlFor={fieldId("destPort")}
                label={isRemote ? t("tunnels.editor.localPortRequired") : t("tunnels.editor.remotePortRequired")}
                disabled={isDynamic}
              >
                <input
                  className="taomni-input w-20"
                  type="number"
                  {...fieldProps("destPort")}
                  placeholder="5432"
                  value={draft.destPort || ""}
                  onChange={(e) => update("destPort", Number(e.target.value))}
                  disabled={isDynamic}
                />
              </Field>
              {isDynamic && (
                <div className="text-ui-small" style={{ color: "var(--taomni-text-muted)" }}>
                  {t("tunnels.editor.dynamicHintPrefix")}{" "}
                  <strong>
                    socks5://{draft.listenHost || "127.0.0.1"}:{draft.listenPort || "<port>"}
                  </strong>{" "}
                  {t("tunnels.editor.dynamicHintSuffix")}
                </div>
              )}
            </DiagramCard>
          </div>

          {/* Description / autostart */}
          <div className="mt-4 grid grid-cols-12 gap-3 items-center">
            <label htmlFor={fieldId("description")} className="col-span-2 text-ui-body text-right">{t("tunnels.editor.description")}</label>
            <input
              id={fieldId("description")}
              className="taomni-input col-span-7"
              placeholder={t("tunnels.editor.descriptionPlaceholder")}
              value={draft.description ?? ""}
              onChange={(e) => update("description", e.target.value)}
            />
            <label className="col-span-3 flex items-center gap-1.5 text-ui-body justify-end">
              <input
                type="checkbox"
                className="taomni-checkbox"
                checked={!!draft.autostart}
                onChange={(e) => update("autostart", e.target.checked)}
              />
              {t("tunnels.editor.autostartLaunch")}
            </label>
          </div>

          {(error || showFieldError) && (
            <div
              role="alert" id={fieldId("error")}
              className="mt-3 px-3 py-2 rounded text-ui-body select-text"
              style={{ background: "var(--taomni-danger-bg)", color: "var(--taomni-danger-text)", border: "1px solid var(--taomni-danger-border)" }}
            >
              {error ?? (validation && t(validation.message))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="h-12 flex items-center justify-center gap-3 border-t shrink-0"
          style={{ background: "var(--taomni-quick-bg)", borderColor: "var(--taomni-divider)" }}
        >
          <button
            type="button"
            className="taomni-btn flex items-center gap-1.5"
            data-testid="tunnel-editor-save"
            data-primary="true"
            onClick={handleSave}
            disabled={busy}
          >
            <SaveIcon className="w-3.5 h-3.5" /> {busy ? t("tunnels.editor.saving") : t("tunnels.editor.save")}{shortcuts.save}
          </button>
          <button type="button" className="taomni-btn flex items-center gap-1.5" data-testid="tunnel-editor-cancel" onClick={onCancel} disabled={busy}>
            <XCircle className="w-3.5 h-3.5" /> {t("tunnels.editor.cancel")}{shortcuts.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}

function DiagramCard({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-md border p-3 flex flex-col gap-1.5"
      style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-panel-bg)" }}
    >
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <div>
          <div className="text-ui-body font-semibold">{title}</div>
          <div className="text-ui-caption" style={{ color: "var(--taomni-text-muted)" }}>{subtitle}</div>
        </div>
      </div>
      {children}
    </div>
  );
}

function Field({
  htmlFor,
  label,
  disabled = false,
  children,
}: {
  htmlFor: string;
  label: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex items-center gap-2 text-ui-body"
      style={{ opacity: disabled ? 0.45 : 1 }}
    >
      <label htmlFor={htmlFor} className="w-32 text-right shrink-0" style={{ color: "var(--taomni-text-muted)" }}>{label}</label>
      <div className="flex items-center gap-1 flex-wrap">{children}</div>
    </div>
  );
}
