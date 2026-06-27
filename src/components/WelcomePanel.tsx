import {
  Terminal as TerminalIcon,
  Plus,
  Shield,
  FolderOpen,
  MessageCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  listLocalShells,
  listWslDistros,
  openLocalShellAsAdministrator,
  type LocalShellOption,
  type WslDistro,
} from "../lib/ipc";
import { getAppPlatform } from "../lib/runtime";
import { sftpLocalHome } from "../lib/sftp";
import { useAppStore } from "../stores/appStore";
import type { LocalShellSelection } from "../types";
import { useT, type TranslateFn } from "../lib/i18n";

interface WelcomePanelProps {
  onStartLocalTerminal: (shell?: LocalShellSelection) => void;
  onNewSession: () => void;
  onOpenLocalPath?: (path: string, opts?: { embedFolder?: boolean }) => void;
  onOpenLanChat?: () => void;
}

export function WelcomePanel({ onStartLocalTerminal, onNewSession, onOpenLocalPath, onOpenLanChat }: WelcomePanelProps) {
  const [localShells, setLocalShells] = useState<LocalShellOption[]>([]);
  const [selectedShellId, setSelectedShellId] = useState("");
  const [shellStatus, setShellStatus] = useState<"loading" | "ready" | "error">("loading");
  const [wslDistros, setWslDistros] = useState<WslDistro[]>([]);
  const [selectedDistro, setSelectedDistro] = useState("");
  const [wslStatus, setWslStatus] = useState<"loading" | "ready" | "error" | "unsupported">("loading");
  const { setStatusMessage } = useAppStore();
  const t = useT();

  useEffect(() => {
    let cancelled = false;

    listLocalShells()
      .then((shells) => {
        if (cancelled) return;
        const list = Array.isArray(shells) ? shells : [];
        setLocalShells(list);
        setSelectedShellId(list.find((shell) => shell.isDefault)?.id ?? list[0]?.id ?? "");
        setShellStatus("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setShellStatus("error");
        setStatusMessage(t("status.localShellDetectionFailed", { error: String(error) }));
      });

    if (getAppPlatform() === "windows") {
      listWslDistros()
        .then((distros) => {
          if (cancelled) return;
          const list = Array.isArray(distros) ? distros : [];
          setWslDistros(list);
          setSelectedDistro(list.find((d) => d.isDefault)?.name ?? list[0]?.name ?? "");
          setWslStatus("ready");
        })
        .catch((error) => {
          if (cancelled) return;
          setWslStatus("error");
          setStatusMessage(t("welcome.wslDetectFailed", { error: String(error) }));
        });
    } else {
      setWslStatus("unsupported");
    }

    return () => {
      cancelled = true;
    };
  }, [setStatusMessage, t]);

  const mergedShells = useMemo<LocalShellOption[]>(() => {
    if (wslDistros.length === 0) return localShells;
    const virtual: LocalShellOption[] = wslDistros.map((d) => ({
      id: `wsl:${d.name}`,
      name: `WSL: ${d.name}`,
      path: "wsl.exe",
      args: ["-d", d.name],
      isDefault: false,
      canElevate: true,
    }));
    return [...localShells, ...virtual];
  }, [localShells, wslDistros]);

  const selectedShell = useMemo(
    () => mergedShells.find((shell) => shell.id === selectedShellId),
    [mergedShells, selectedShellId],
  );

  const handleStartAsAdministrator = async () => {
    try {
      await openLocalShellAsAdministrator(selectedShell?.id);
      setStatusMessage(t("status.administratorRequested", {
        shell: selectedShell?.name ?? t("welcome.defaultShell"),
      }));
    } catch (error) {
      setStatusMessage(t("status.administratorFailed", { error: String(error) }));
    }
  };

  const handleOpenHomeFolder = async () => {
    if (!onOpenLocalPath) return;
    try {
      const home = await sftpLocalHome();
      if (home) onOpenLocalPath(home, { embedFolder: true });
    } catch (error) {
      setStatusMessage(t("status.homeLookupFailed", { error: String(error) }));
    }
  };

  return (
    <div data-testid="welcome-panel" className="w-full h-full min-w-0 overflow-auto" style={{ background: "var(--taomni-bg)" }}>
      <div className="w-full max-w-[1320px] mx-auto px-6 sm:px-8 lg:px-10 py-8">
        <div className="flex items-center gap-3 mb-5">
          <div
            data-testid="welcome-brand-mark"
            className="w-12 h-12 rounded-lg flex items-center justify-center text-white font-bold text-xl"
            style={{ background: "linear-gradient(135deg, #1e5fa8, #62d36f)" }}
          >
            T
          </div>
          <div>
            <div className="text-xl font-semibold">{t("app.welcomeTitle")}</div>
            <div className="text-[12px] text-[var(--taomni-text-muted)]">
              {t("app.tagline")}
            </div>
            <div
              data-testid="welcome-version"
              className="text-[11px] mt-0.5 taomni-mono"
              style={{ color: "var(--taomni-text-muted)" }}
            >
              {t("welcome.versionLabel", { version: __APP_VERSION__ })}
            </div>
          </div>
        </div>

        <div
          className="grid gap-4 items-stretch"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))" }}
        >
          <LocalTerminalCard
            translate={t}
            shells={mergedShells}
            selectedShell={selectedShell}
            selectedShellId={selectedShellId}
            shellStatus={shellStatus}
            onSelectShell={setSelectedShellId}
            kbd="Ctrl+Shift+T"
            onStart={() => {
              if (!selectedShell) {
                onStartLocalTerminal();
                return;
              }
              onStartLocalTerminal({
                // Real shells have id === path; virtual WSL entries map id="wsl:<distro>"
                // to path="wsl.exe" — pass the executable path so the backend can resolve it.
                id: selectedShell.path,
                name: selectedShell.name,
                ...(selectedShell.args && selectedShell.args.length > 0
                  ? { args: selectedShell.args }
                  : {}),
              });
            }}
            onStartAsAdministrator={handleStartAsAdministrator}
            onOpenHomeFolder={onOpenLocalPath ? () => void handleOpenHomeFolder() : undefined}
          />
          {wslStatus === "ready" && wslDistros.length > 0 && (
            <WslCard
              translate={t}
              distros={wslDistros}
              selectedDistro={selectedDistro}
              onSelectDistro={setSelectedDistro}
              onStart={() => {
                if (!selectedDistro) return;
                onStartLocalTerminal({
                  id: "wsl.exe",
                  name: `WSL: ${selectedDistro}`,
                  args: ["-d", selectedDistro],
                });
              }}
            />
          )}
          <ActionCard
            icon={<Plus className="w-5 h-5" />}
            title={t("welcome.newSessionTitle")}
            desc={t("welcome.newSessionDesc")}
            kbd="Ctrl+Shift+N"
            onClick={() => onNewSession()}
          />
          {onOpenLanChat ? (
            <ActionCard
              testId="welcome-open-lanchat"
              icon={<MessageCircle className="w-5 h-5" />}
              title={t("welcome.lanChatTitle")}
              desc={t("welcome.lanChatDesc")}
              kbd=""
              onClick={onOpenLanChat}
            />
          ) : null}
        </div>

        <div className="mt-7 text-[12px] text-[var(--taomni-text-muted)]">
          <div className="font-semibold text-[var(--taomni-text)] mb-1">{t("welcome.tipsHeading")}</div>
          <ul className="list-disc pl-5 space-y-0.5">
            <li
              dangerouslySetInnerHTML={{
                __html: t("welcome.tipQuickConnect", {
                  example: '<span class="taomni-mono px-1 border rounded" style="background: var(--taomni-input-bg); border-color: var(--taomni-divider);">ssh user@host:22</span>',
                }),
              }}
            />
            <li>{t("welcome.tipRightClick")}</li>
            <li>{t("welcome.tipDrag")}</li>
          </ul>
        </div>

        <div
          data-testid="welcome-version-footer"
          className="mt-7 pt-3 flex items-center justify-between text-[11px] taomni-mono"
          style={{
            borderTop: "1px solid var(--taomni-divider)",
            color: "var(--taomni-text-muted)",
          }}
        >
          <span>{t("app.name")}</span>
          <span>v{__APP_VERSION__}</span>
        </div>
      </div>
    </div>
  );
}

function LocalTerminalCard({
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

function WslCard({
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

function ActionCard({
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
