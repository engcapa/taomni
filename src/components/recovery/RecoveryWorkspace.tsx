import { useEffect, useState } from "react";
import { useWindowAppearance } from "../../hooks/useWindowAppearance";
import { useT } from "../../lib/i18n";
import { pageZoomCommands, zoomBinding, zoomFromMenu } from "../../lib/pageZoom";
import { useContextMenu } from "../ContextMenu";
import { PageZoomPanel } from "../ui/PageZoomPanel";
import { Button } from "../ui/Button";
import { invoke } from "@tauri-apps/api/core";
import type { RecoveryBootstrap } from "../../lib/runtimeRecovery";
import { RecoveryTerminalOutput } from "./RecoveryTerminalOutput";
import { recoveryLimitation } from "../../lib/recoveryPolicy";
import { RecoveryBackgroundStatus } from "./RecoveryBackgroundStatus";

/** Recovery is deliberately not a normal Tab mount: no connect / cleanup / autosave side effects. */
export function RecoveryWorkspace({ bootstrap }: { bootstrap: RecoveryBootstrap }) {
  useWindowAppearance();
  const t = useT();
  const viewMenu = useContextMenu();
  const tabs = bootstrap.description?.tabs ?? [];
  const [selected, setSelected] = useState(bootstrap.description?.activeTabId ?? tabs[0]?.id ?? "");
  const [handshake, setHandshake] = useState("checking");
  const tab = tabs.find((entry) => entry.id === selected);
  useEffect(() => {
    let current = true;
    // StrictMode repeats effects; share this handshake rather than issuing a second ready.
    void readyOnce(bootstrap).then(
      () => { if (current) setHandshake("ready"); },
      () => { if (current) setHandshake("handshakeFailed"); },
    );
    return () => { current = false; };
  }, [bootstrap]);
  return (
    <main data-testid="recovery-workspace" className="h-screen overflow-auto bg-[var(--taomni-bg)] text-[var(--taomni-text)]">
      <PageZoomPanel active data-testid="recovery-page" className="grid content-start gap-3 p-6">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-ui-heading font-semibold">{t("recovery.title")}</h1>
          <Button data-testid="recovery-view-menu" aria-haspopup="menu" aria-expanded={viewMenu.isOpen}
            onClick={(event) => {
              const { left, bottom } = event.currentTarget.getBoundingClientRect();
              viewMenu.showAt(left, bottom, pageZoomCommands.map(({ id, action, label, key }) => ({
                label: t(label), shortcut: zoomBinding(key), testId: `recovery-${id}`, onClick: () => zoomFromMenu(action),
              })));
            }}>{t("menu.view")}</Button>
        </header>
        <p data-testid="recovery-handshake" role="status">{t(`recovery.${handshake}`)}</p>
        <p data-testid="recovery-limitations">{t("recovery.limitations")}</p>
        {tabs.length === 0 && <p data-testid="recovery-missing">{t("recovery.missing")}</p>}
        <nav aria-label={t("recovery.tabs")} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {tabs.map((entry) => <Button variant={entry.id === selected ? "primary" : "default"} key={entry.id} data-testid="recovery-tab" data-kind={entry.kind}
            aria-pressed={entry.id === selected} onClick={() => setSelected(entry.id)}>{entry.title}</Button>)}
        </nav>
        {tab && <section data-testid="recovery-detail" aria-live="polite">
          <h2>{tab.title}</h2>
          <p data-testid="recovery-kind">{t("recovery.kind", { kind: tab.kind })}</p>
          <p data-testid="recovery-policy">{recoveryLimitation(tab.kind)}</p>
          {tab.terminalSessionId
            ? <p data-testid="recovery-terminal-id">{t("recovery.originalTerminal", { id: tab.terminalSessionId })}</p>
            : <p data-testid="recovery-unknown">{t("recovery.unknownState")}</p>}
          {tab.terminalSessionId && <RecoveryTerminalOutput key={tab.terminalSessionId} sessionId={tab.terminalSessionId} />}
          {tab.kind === "mail" || tab.kind === "mail-unified"
            ? <p data-testid="recovery-mail-warning">{t("recovery.policy.mail")}</p> : null}
        </section>}
        <RecoveryBackgroundStatus />
        <p>{t("recovery.closeOptions")}</p>
        {viewMenu.render}
      </PageZoomPanel>
    </main>
  );
}

// Per-renderer only; never persisted across native process restarts.
const handshakes = new WeakMap<RecoveryBootstrap, Promise<unknown>>();
function readyOnce(bootstrap: RecoveryBootstrap): Promise<unknown> {
  let promise = handshakes.get(bootstrap);
  if (!promise) {
    promise = invoke("recovery_ready", { instanceId: bootstrap.instanceId, generation: bootstrap.generation });
    handshakes.set(bootstrap, promise);
  }
  return promise;
}
