import { useEffect, useMemo, useState } from "react";
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
import { defaultTunnel } from "../../lib/tunnel";
import type { SessionConfig } from "../../lib/ipc";
import { vaultPut, isVaultReference, isVaultLockedError } from "../../lib/ipc";
import { useVaultStore } from "../../stores/vaultStore";
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

  const validate = (): string | null => {
    if (!draft.name.trim()) return t("tunnels.editor.errNameRequired");
    if (!draft.ssh.host.trim()) return t("tunnels.editor.errHostRequired");
    if (!draft.ssh.username.trim()) return t("tunnels.editor.errUsernameRequired");
    if (!Number.isFinite(draft.ssh.port) || draft.ssh.port <= 0) return t("tunnels.editor.errSshPort");
    if (!Number.isFinite(draft.listenPort) || draft.listenPort <= 0)
      return draft.kind === "Remote" ? t("tunnels.editor.errRemotePortGt0") : t("tunnels.editor.errForwardPortGt0");
    if (draft.kind !== "Dynamic") {
      if (!draft.destHost.trim()) return t("tunnels.editor.errDestHostRequired");
      if (!Number.isFinite(draft.destPort) || draft.destPort <= 0) return t("tunnels.editor.errRemotePortGt0");
    }
    return null;
  };

  const handleSave = async () => {
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
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
        vaultState !== "empty" &&
        next.ssh.authData &&
        !isVaultReference(next.ssh.authData)
      ) {
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(20,30,45,0.45)" }}>
      <div
        data-testid="tunnel-editor"
        className="w-[940px] max-w-[96%] max-h-[92vh] flex flex-col rounded-[6px] shadow-2xl border overflow-hidden"
        style={{ background: "var(--moba-panel-bg)", borderColor: "var(--moba-chrome-border)", color: "var(--moba-text)" }}
      >
        {/* Title bar */}
        <div
          className="h-7 flex items-center px-2 rounded-t-[5px] shrink-0"
          style={{ background: "linear-gradient(to bottom,#5895c8,#2b5d8b)", color: "white" }}
        >
          <LinkIcon className="w-3.5 h-3.5 mr-1.5" />
          <div className="text-[12px] font-semibold">{initial ? t("tunnels.editor.titleEdit") : t("tunnels.editor.titleNew")}</div>
          <button
            title={t("tunnels.editor.close")}
            className="ml-auto hover:bg-red-500 rounded p-0.5"
            onClick={onCancel}
            type="button"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Mode picker */}
        <div className="px-4 py-3 border-b shrink-0 grid grid-cols-3 gap-3" style={{ borderColor: "var(--moba-divider)" }}>
          {KIND_OPTION_KEYS.map((opt) => (
            <label
              key={opt.id}
              className="flex items-start gap-2 cursor-pointer p-2 rounded border"
              style={{
                borderColor: draft.kind === opt.id ? "var(--moba-accent)" : "var(--moba-divider)",
                background: draft.kind === opt.id ? "var(--moba-selected)" : "transparent",
              }}
            >
              <input
                type="radio"
                className="moba-radio mt-0.5"
                checked={draft.kind === opt.id}
                onChange={() => update("kind", opt.id)}
              />
              <div className="text-[12px] leading-tight">
                <div className="font-semibold" style={{ color: draft.kind === opt.id ? "var(--moba-accent)" : "var(--moba-text)" }}>
                  {t(opt.label)}
                </div>
                <div className="text-[11px] mt-0.5" style={{ color: "var(--moba-text-muted)" }}>
                  {t(opt.description)}
                </div>
              </div>
            </label>
          ))}
        </div>

        {/* Diagram */}
        <div
          className="flex-1 min-h-0 overflow-auto px-4 py-4"
          style={{ background: "var(--moba-bg)" }}
        >
          {/* Name / saved-session row */}
          <div className="flex items-center gap-2 mb-4">
            <label className="text-[12px] w-28 text-right">{t("tunnels.editor.tunnelNameRequired")}</label>
            <input
              className="moba-input w-64"
              placeholder={t("tunnels.editor.namePlaceholder")}
              value={draft.name}
              onChange={(e) => update("name", e.target.value)}
            />
            <label className="text-[12px] w-32 text-right ml-3">{t("tunnels.editor.useSavedSession")}</label>
            <select
              className="moba-input w-64 appearance-none"
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
              icon={isRemote ? <Server className="w-7 h-7" style={{ color: "#2b5d8b" }} /> : <Users className="w-7 h-7" style={{ color: "#c97a23" }} />}
              title={isRemote ? t("tunnels.editor.remoteClients") : t("tunnels.editor.localClients")}
              subtitle={isRemote ? t("tunnels.editor.remoteClientsDesc") : t("tunnels.editor.localClientsDesc")}
            >
              <Field label={forwardedLabel}>
                <input
                  className="moba-input w-24"
                  type="number"
                  placeholder="0"
                  value={draft.listenPort || ""}
                  onChange={(e) => update("listenPort", parseInt(e.target.value || "0", 10) || 0)}
                />
                <span className="text-[11px] ml-1" style={{ color: "var(--moba-text-muted)" }}>
                  {isRemote ? t("tunnels.editor.serverBindHint") : t("tunnels.editor.listenHint")}
                </span>
              </Field>
              <Field label={isRemote ? t("tunnels.editor.bindAddress") : t("tunnels.editor.listenAddress")}>
                <input
                  className="moba-input w-32"
                  placeholder={isRemote ? "0.0.0.0" : "127.0.0.1"}
                  value={draft.listenHost}
                  onChange={(e) => update("listenHost", e.target.value)}
                />
              </Field>
              {isRemote && (
                <div className="text-[11px] mt-2" style={{ color: "var(--moba-text-muted)" }}>
                  {t("tunnels.editor.remoteListenNote")}
                </div>
              )}
              <div className="flex items-center justify-end mt-2">
                <ArrowRight className="w-5 h-5" style={{ color: "var(--moba-accent)" }} />
              </div>
            </DiagramCard>

            {/* Middle column: SSH tunnel through firewall */}
            <DiagramCard
              icon={<Flame className="w-7 h-7" style={{ color: "#d35a2c" }} />}
              title={t("tunnels.editor.sshTunnelTitle")}
              subtitle={t("tunnels.editor.sshTunnelDesc")}
            >
              <Field label={t("tunnels.editor.sshServerRequired")}>
                <input
                  className="moba-input w-44"
                  placeholder="ssh.example.com"
                  value={draft.ssh.host}
                  onChange={(e) => updateSsh("host", e.target.value)}
                />
              </Field>
              <Field label={t("tunnels.editor.sshLoginRequired")}>
                <input
                  className="moba-input w-32"
                  placeholder="user"
                  value={draft.ssh.username}
                  onChange={(e) => updateSsh("username", e.target.value)}
                />
              </Field>
              <Field label={t("tunnels.editor.sshPort")}>
                <input
                  className="moba-input w-20"
                  type="number"
                  placeholder="22"
                  value={draft.ssh.port || ""}
                  onChange={(e) => updateSsh("port", parseInt(e.target.value || "22", 10) || 22)}
                />
              </Field>
              <Field label={t("tunnels.editor.auth")}>
                <select
                  className="moba-input w-32 appearance-none"
                  value={draft.ssh.authMethod}
                  onChange={(e) => updateSsh("authMethod", e.target.value as "Password" | "PrivateKey" | "Agent")}
                >
                  <option value="Password">{t("tunnels.editor.authPassword")}</option>
                  <option value="PrivateKey">{t("tunnels.editor.authPrivateKey")}</option>
                  <option value="Agent">{t("tunnels.editor.authAgent")}</option>
                </select>
              </Field>
              <Field
                label={draft.ssh.authMethod === "PrivateKey" ? t("tunnels.editor.keyPath") : t("tunnels.editor.password")}
                disabled={draft.ssh.authMethod === "Agent"}
              >
                <input
                  id="tunnel-editor-auth-data"
                  className="moba-input w-44"
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
              <Field label={t("tunnels.editor.vault")} disabled={draft.ssh.authMethod === "Agent"}>
                <label
                  className="flex items-center gap-1.5 text-[11px]"
                  title={
                    vaultState === "empty"
                      ? t("tunnels.editor.vaultEmptyHint")
                      : undefined
                  }
                >
                  <input
                    type="checkbox"
                    className="moba-checkbox"
                    checked={!!draft.ssh.saveAuth}
                    onChange={(e) => updateSsh("saveAuth", e.target.checked)}
                    disabled={
                      draft.ssh.authMethod === "Agent" ||
                      (vaultState === "empty" && !draft.ssh.saveAuth)
                    }
                  />
                  {t("tunnels.editor.saveCredentials")}
                </label>
              </Field>
              {draft.ssh.saveAuth && draft.ssh.authMethod === "Password" && vaultState === "empty" && (
                <div className="text-[10.5px] pl-[6.25rem]" style={{ color: "#a04b00" }}>
                  {t("tunnels.editor.vaultNotInit")}
                </div>
              )}
            </DiagramCard>

            {/* Right column: Remote/SOCKS endpoint */}
            <DiagramCard
              icon={
                isDynamic ? (
                  <Globe className="w-7 h-7" style={{ color: "#1e6db8" }} />
                ) : isRemote ? (
                  <Monitor className="w-7 h-7" style={{ color: "#2b5d8b" }} />
                ) : (
                  <Server className="w-7 h-7" style={{ color: "#1e6db8" }} />
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
                <ArrowLeft className="w-5 h-5" style={{ color: "var(--moba-accent)" }} />
              </div>
              <Field
                label={isRemote ? t("tunnels.editor.localTargetRequired") : t("tunnels.editor.remoteServerRequired", { label: destLabel })}
                disabled={isDynamic}
              >
                <input
                  className="moba-input w-44"
                  placeholder={isRemote ? "127.0.0.1" : "db.internal"}
                  value={draft.destHost}
                  onChange={(e) => update("destHost", e.target.value)}
                  disabled={isDynamic}
                />
              </Field>
              <Field
                label={isRemote ? t("tunnels.editor.localPortRequired") : t("tunnels.editor.remotePortRequired")}
                disabled={isDynamic}
              >
                <input
                  className="moba-input w-20"
                  type="number"
                  placeholder="5432"
                  value={draft.destPort || ""}
                  onChange={(e) => update("destPort", parseInt(e.target.value || "0", 10) || 0)}
                  disabled={isDynamic}
                />
              </Field>
              {isDynamic && (
                <div className="text-[11px]" style={{ color: "var(--moba-text-muted)" }}>
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
            <label className="col-span-2 text-[12px] text-right">{t("tunnels.editor.description")}</label>
            <input
              className="moba-input col-span-7"
              placeholder={t("tunnels.editor.descriptionPlaceholder")}
              value={draft.description ?? ""}
              onChange={(e) => update("description", e.target.value)}
            />
            <label className="col-span-3 flex items-center gap-1.5 text-[12px] justify-end">
              <input
                type="checkbox"
                className="moba-checkbox"
                checked={!!draft.autostart}
                onChange={(e) => update("autostart", e.target.checked)}
              />
              {t("tunnels.editor.autostartLaunch")}
            </label>
          </div>

          {error && (
            <div
              className="mt-3 px-3 py-2 rounded text-[12px]"
              style={{ background: "#fff1f0", color: "#9b1c1c", border: "1px solid #f5b3b3" }}
            >
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="h-12 flex items-center justify-center gap-3 border-t shrink-0"
          style={{ background: "var(--moba-quick-bg)", borderColor: "var(--moba-divider)" }}
        >
          <button
            type="button"
            className="moba-btn flex items-center gap-1.5"
            data-testid="tunnel-editor-save"
            data-primary="true"
            onClick={handleSave}
            disabled={busy}
          >
            <SaveIcon className="w-3.5 h-3.5" /> {busy ? t("tunnels.editor.saving") : t("tunnels.editor.save")}
          </button>
          <button type="button" className="moba-btn flex items-center gap-1.5" data-testid="tunnel-editor-cancel" onClick={onCancel} disabled={busy}>
            <XCircle className="w-3.5 h-3.5" /> {t("tunnels.editor.cancel")}
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
      style={{ borderColor: "var(--moba-divider)", background: "var(--moba-panel-bg)" }}
    >
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <div>
          <div className="text-[12px] font-semibold">{title}</div>
          <div className="text-[10.5px]" style={{ color: "var(--moba-text-muted)" }}>{subtitle}</div>
        </div>
      </div>
      {children}
    </div>
  );
}

function Field({
  label,
  disabled = false,
  children,
}: {
  label: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex items-center gap-2 text-[12px]"
      style={{ opacity: disabled ? 0.45 : 1 }}
    >
      <label className="w-24 text-right shrink-0" style={{ color: "var(--moba-text-muted)" }}>{label}</label>
      <div className="flex items-center gap-1 flex-wrap">{children}</div>
    </div>
  );
}
