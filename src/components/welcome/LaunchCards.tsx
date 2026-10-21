import { Terminal as TerminalIcon, Shield, FolderOpen, Mail as MailIcon } from "lucide-react";
import { type LocalShellOption, type SessionConfig, type WslDistro } from "../../lib/ipc";
import { type TranslateFn } from "../../lib/i18n";


export function LocalTerminalCard({
  translate: t,
  shells,
  selectedShell,
  selectedShellId,
  shellStatus,
  onSelectShell,
  kbd,
  onStart,
  onStartAsAdministrator,
  onOpenHomeFolder,
}: {
  translate: TranslateFn;
  shells: LocalShellOption[];
  selectedShell?: LocalShellOption;
  selectedShellId: string;
  shellStatus: "loading" | "ready" | "error";
  onSelectShell: (id: string) => void;
  kbd: string;
  onStart: () => void;
  onStartAsAdministrator: () => void;
  onOpenHomeFolder?: () => void;
}) {
  const hasChoices = shells.length > 1;
  const canElevate = selectedShell?.canElevate ?? false;
  const detail = selectedShell?.path ?? (
    shellStatus === "loading" ? t("welcome.detectingShells") : t("welcome.useDefault")
  );

  return (
    <div
      className="text-left p-4 min-h-[170px] h-full rounded-md border taomni-card-hover flex flex-col"
      style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-card-bg)" }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span style={{ color: "var(--taomni-accent)" }}><TerminalIcon className="w-5 h-5" /></span>
        <span className="font-semibold">{t("welcome.localTerminal")}</span>
        {kbd && (
          <span
            className="ml-auto text-[10px] taomni-mono px-1.5 py-0.5 rounded border"
            style={{
              background: "var(--taomni-input-bg)",
              borderColor: "var(--taomni-divider)",
              color: "var(--taomni-text-muted)",
            }}
          >
            {kbd}
          </span>
        )}
      </div>
      <div className="text-[12px] text-[var(--taomni-text-muted)]">
        {selectedShell ? t("welcome.openShell", { shell: selectedShell.name }) : t("welcome.openLocalShell")}
      </div>

      <div className="mt-3 space-y-3">
        {hasChoices ? (
          <select
            className="taomni-input h-8 w-full"
            aria-label={t("welcome.terminalShellAria")}
            value={selectedShellId}
            title={selectedShell?.path}
            onChange={(event) => onSelectShell(event.target.value)}
          >
            {shells.map((shell) => (
              <option key={shell.id} value={shell.id}>
                {shell.name}{shell.isDefault ? t("welcome.defaultLabel") : ""}
              </option>
            ))}
          </select>
        ) : (
          <div
            className="taomni-input h-8 w-full flex items-center truncate"
            title={detail}
            style={{ color: selectedShell ? "var(--taomni-text)" : "var(--taomni-text-muted)" }}
          >
            {selectedShell?.name ?? (shellStatus === "loading" ? t("welcome.detectingShellsShort") : t("welcome.defaultShell"))}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 flex-wrap">
          <button data-testid="welcome-open-local-terminal" className="taomni-btn h-8 px-3" onClick={onStart} type="button">
            {t("welcome.open")}
          </button>
          {canElevate && (
            <button
              className="taomni-btn h-8 px-3 inline-flex items-center gap-1.5"
              onClick={onStartAsAdministrator}
              title={t("welcome.adminTitle")}
              aria-label={t("welcome.adminTitle")}
              type="button"
            >
              <Shield className="w-3.5 h-3.5" />
              <span>{t("welcome.admin")}</span>
            </button>
          )}
          {onOpenHomeFolder && (
            <button
              data-testid="welcome-open-home-folder"
              className="taomni-btn h-8 px-3 inline-flex items-center gap-1.5"
              onClick={onOpenHomeFolder}
              title={t("welcome.homeFolderTitle")}
              type="button"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              <span>{t("welcome.homeFolder")}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}


export function WslCard({
  translate: t,
  distros,
  selectedDistro,
  onSelectDistro,
  onStart,
}: {
  translate: TranslateFn;
  distros: WslDistro[];
  selectedDistro: string;
  onSelectDistro: (name: string) => void;
  onStart: () => void;
}) {
  const current = distros.find((d) => d.name === selectedDistro);
  const detail = current
    ? t("welcome.wslDetail", {
      state: current.state,
      version: current.version != null ? String(current.version) : "?",
    })
    : t("welcome.wslOpenDesc");

  return (
    <div
      data-testid="welcome-wsl-card"
      className="text-left p-4 min-h-[170px] h-full rounded-md border taomni-card-hover flex flex-col"
      style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-card-bg)" }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span style={{ color: "#0078d4" }}>
          <TerminalIcon className="w-5 h-5" />
        </span>
        <span className="font-semibold">{t("welcome.openWsl")}</span>
      </div>
      <div className="text-[12px] text-[var(--taomni-text-muted)]">{detail}</div>

      <div className="mt-3 space-y-3">
        <select
          data-testid="welcome-wsl-distro"
          className="taomni-input h-8 w-full"
          aria-label={t("welcome.wslDistroAria")}
          value={selectedDistro}
          onChange={(event) => onSelectDistro(event.target.value)}
        >
          {distros.map((d) => (
            <option key={d.name} value={d.name}>
              {d.name}{d.isDefault ? t("welcome.defaultLabel") : ""}
            </option>
          ))}
        </select>
        <div className="flex items-center justify-end gap-2 flex-wrap">
          <button
            data-testid="welcome-wsl-open"
            className="taomni-btn h-8 px-3"
            onClick={onStart}
            type="button"
          >
            {t("welcome.openWslButton")}
          </button>
        </div>
      </div>
    </div>
  );
}


export function MailSessionsCard({
  translate: t,
  sessions,
  onOpen,
}: {
  translate: TranslateFn;
  sessions: SessionConfig[];
  onOpen?: (session: SessionConfig) => void;
}) {
  return (
    <div
      data-testid="welcome-mail-card"
      className="text-left p-4 min-h-[138px] h-full rounded-md border taomni-card-hover flex flex-col"
      style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-card-bg)" }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span style={{ color: "var(--taomni-accent)" }}><MailIcon className="w-5 h-5" /></span>
        <span className="font-semibold">{t("welcome.mailTitle")}</span>
        <span className="ml-auto text-[11px] taomni-mono text-[var(--taomni-text-muted)]">{sessions.length}</span>
      </div>
      <div className="text-[12px] text-[var(--taomni-text-muted)]">{t("welcome.mailDesc")}</div>
      <div className="mt-3 flex-1 min-h-0 max-h-[132px] overflow-auto space-y-1">
        {sessions.map((session) => {
          const title = session.name || session.username || session.host || "Mailbox";
          const detail = session.username || session.host || "";
          return (
            <button
              key={session.id}
              data-testid="welcome-mail-session"
              className="w-full text-left rounded border px-2 py-1.5 flex items-center gap-2 hover:bg-[var(--taomni-control-hover)]"
              style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-input-bg)" }}
              type="button"
              disabled={!onOpen}
              aria-label={t("welcome.mailOpenAria", { name: title })}
              onClick={() => onOpen?.(session)}
            >
              <MailIcon className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-accent)]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium text-[var(--taomni-accent)]">{title}</span>
                {detail && detail !== title ? (
                  <span className="block truncate text-[11px] text-[var(--taomni-text-muted)]">{detail}</span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}


export function ActionCard({
  testId,
  icon,
  title,
  desc,
  kbd,
  onClick,
}: {
  testId?: string;
  icon: React.ReactNode;
  title: string;
  desc: string;
  kbd: string;
  onClick: () => void;
}) {
  return (
    <button
      data-testid={testId}
      className="text-left p-4 min-h-[138px] h-full rounded-md border taomni-card-hover flex flex-col"
      style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-card-bg)" }}
      onClick={onClick}
      type="button"
    >
      <div className="flex items-center gap-2 mb-1">
        <span style={{ color: "var(--taomni-accent)" }}>{icon}</span>
        <span className="font-semibold">{title}</span>
        {kbd && (
          <span
            className="ml-auto text-[10px] taomni-mono px-1.5 py-0.5 rounded border"
            style={{
              background: "var(--taomni-input-bg)",
              borderColor: "var(--taomni-divider)",
              color: "var(--taomni-text-muted)",
            }}
          >
            {kbd}
          </span>
        )}
      </div>
      <div className="text-[12px] text-[var(--taomni-text-muted)]">{desc}</div>
    </button>
  );
}
