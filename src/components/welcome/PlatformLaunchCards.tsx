import { showAgentsComingSoon } from "../agents/comingSoon";
import { Bot, Boxes, ChevronDown, GitBranch, KeyRound, MessageCircle, Monitor, Plus, Upload, Wrench } from "lucide-react";
import { useContextMenu } from "../ContextMenu";
import { useSessionImportExport } from "../menubar/useSessionImportExport";
import { useT } from "../../lib/i18n";
import { useAppStore } from "../../stores/appStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";

/** Launch actions share the existing import, workspace and utility owners. */
export function PlatformLaunchCards({ onNewSession, onOpenLanChat, onOpenNewWorkspace }: {
  onNewSession: () => void;
  onOpenLanChat?: () => void;
  onOpenNewWorkspace?: () => void;
}) {
  const t = useT();
  const menu = useContextMenu();
  const imports = useSessionImportExport();
  const mode = useAppStore((s) => s.setActiveSideTab);
  const command = (name: string) => window.dispatchEvent(new CustomEvent("taomni:command", { detail: name }));
  const openGit = () => {
    const store = useWorkspacePlatformStore.getState();
    store.openGitTab(store.activeWorkspaceId);
    mode("workspaces");
  };
  return (
    <>
      {menu.render}
      {imports.previewNode}
      <section className="taomni-home-launch-card">
        <div className="taomni-home-card-heading"><Monitor /><strong>{t("welcome.newSessionTitle")}</strong><kbd>Ctrl+Shift+N</kbd></div>
        <p>{t("welcome.newSessionDesc")}</p>
        <div className="taomni-home-card-actions">
          <button type="button" data-testid="welcome-new-session" className="taomni-btn taomni-btn-primary" onClick={onNewSession}><Plus />{t("menu.newSession")}</button>
          <button type="button" data-testid="home-import-sessions" className="taomni-btn" onClick={(event) => menu.show(event, [
            { label: t("menu.importTaomni"), testId: "home-import-json", onClick: imports.importJson },
            { label: t("menu.importMobaXterm"), testId: "home-import-mobaxterm", onClick: imports.importMoba },
            { label: t("menu.importCsv"), testId: "home-import-csv", onClick: imports.importCsv },
            { label: t("menu.downloadCsvTemplate"), testId: "home-download-csv-template", onClick: imports.downloadCsvTemplate },
            { label: t("menu.importOpenSsh"), testId: "home-import-openssh", onClick: imports.importOpenSsh },
          ])}><Upload /><ChevronDown /></button>
        </div>
        <div className="taomni-home-card-footer"><button type="button" onClick={() => mode("sessions")}>{t("platform.sessions")} →</button></div>
      </section>
      <section className="taomni-home-launch-card">
        <div className="taomni-home-card-heading"><Boxes /><strong>{t("platform.workspaces")} &amp; {t("platform.agents")}</strong></div>
        <p>{t("platform.homeHint")}</p>
        <div className="taomni-home-card-actions">
          <button type="button" data-testid="home-open-workspace" className="taomni-btn taomni-btn-primary" onClick={() => onOpenNewWorkspace ? onOpenNewWorkspace() : mode("workspaces")}><Plus />{t("platform.newWorkspace")}</button>
          <button type="button" data-testid="home-open-git" className="taomni-btn" onClick={openGit}><GitBranch />Git</button>
        </div>
        <div className="taomni-home-card-footer"><button type="button" data-testid="home-open-agents" onClick={showAgentsComingSoon}><Bot />{t("platform.agents")}</button></div>
      </section>
      <section className="taomni-home-launch-card">
        <div className="taomni-home-card-heading"><MessageCircle /><strong>{t("platform.tools")}</strong><kbd>LAN / Mail</kbd></div>
        <p>{t("welcome.lanChatDesc")}</p>
        <div className="taomni-home-card-actions">
          {onOpenLanChat && <button type="button" data-testid="welcome-open-lanchat" className="taomni-btn" onClick={onOpenLanChat}>{t("welcome.lanChatTitle")}</button>}
          <button type="button" data-testid="home-open-mail" className="taomni-btn" onClick={() => command("mail-unified")}>{t("tabs.mailUnified")}</button>
        </div>
        <div className="taomni-home-card-footer">
          <button type="button" data-testid="home-open-network-tools" onClick={() => command("tools")}><Wrench />{t("menu.networkTools")}</button>
          <button type="button" data-testid="home-open-mfa" onClick={() => command("mfa")}><KeyRound />MFA</button>
        </div>
      </section>
    </>
  );
}
