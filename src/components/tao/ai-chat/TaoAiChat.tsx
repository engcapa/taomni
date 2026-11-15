import { taoText as tr } from "../i18n";
import { useTaoText } from "../i18n";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { getAppPlatform } from "../../../lib/runtime";
import { registerShellKeyClaim } from "../../../lib/shellKeyClaims";
import { MessageList } from "./MessageList";
import { TaoComposer } from "./Composer";
import { SidePanel } from "./SidePanel";
import { TopBar } from "./TopBar";
import { BudgetCard, BrowserUnavailableCard, RefusalCard, StoppedCard, VaultLockedMask } from "./states/StateCards";
import type { ChatProfile, TaoChatController, TaoChatSlots } from "./ports";

export function TaoAiChat({ controller, profile, slots, disabled = false, active = true, onOpenSettings, onOpenAppearance }: { controller: TaoChatController; profile: ChatProfile; slots?: TaoChatSlots; disabled?: boolean; active?: boolean; onOpenSettings?: () => void; onOpenAppearance?: () => void }) {
  useTaoText();
  const rootRef = useRef<HTMLElement>(null);
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const thread = state.activeThreadId ? state.threads[state.activeThreadId] : undefined;
  const phase = state.activeThreadId ? state.runtime[state.activeThreadId]?.phase ?? "idle" : "idle";
  useEffect(() => {
    if (!active) return;
    const isSearch = (event: KeyboardEvent) => (getAppPlatform() === "macos" ? event.metaKey : event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k";
    const unclaim = rootRef.current ? registerShellKeyClaim(rootRef.current, isSearch) : undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (isSearch(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        controller.setSearchOpen(true);
      }
      if (event.key === "F9") { event.preventDefault(); controller.setDemoMode(!controller.getState().ui.demoMode); }
      if (event.key === "Escape" && state.ui.searchOpen) {
        event.preventDefault();
        controller.setSearchOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); unclaim?.(); };
  }, [controller, state.ui.searchOpen, active]);
  return (
    <section ref={rootRef} className="tao-ai-chat" data-testid="tao-ai-chat" data-tao-active={active}>
      <TopBar state={state} profile={profile} controller={controller} onMode={controller.setMode} onSearch={() => controller.setSearchOpen(true)} onOpenSettings={onOpenSettings} onOpenAppearance={onOpenAppearance} slots={slots?.headerTrailing ?? slots?.headerLeading} />
      <div className={`tao-home-main ${thread?.messages.length ? "has-messages" : "empty"}`}>
        <div className="tao-home-feed" data-testid="tao-home-feed">
          {thread?.messages.length ? <MessageList thread={thread} phase={phase} controller={controller} /> : <div className="tao-home-empty-stage"><div className="tao-home-greeting"><span className="tao-home-logo">T</span><div><h1>{tr("Tao 在这里")}</h1><p>{tr("Develop Buddy · 问、做、深研你的开发问题")}</p></div></div>{slots?.emptyState}</div>}
          <RefusalCard phase={phase} /><BudgetCard phase={phase} controller={controller} /><StoppedCard phase={phase} controller={controller} web={state.composer.web} />
        </div>
        <div className="tao-home-composer-dock"><div className="tao-home-composer-context">{slots?.composerContext}</div><TaoComposer controller={controller} state={state} disabled={disabled} />{slots?.belowComposer}</div>
      </div>
      <VaultLockedMask phase={phase} />
      <SidePanel state={state} profile={profile} controller={controller}>{slots?.sidePanels}</SidePanel>
      <footer className="tao-home-footer"><span>T · Taomni</span><span>v{__APP_VERSION__}</span></footer>
      {disabled && !slots?.emptyState ? <BrowserUnavailableCard onOpenSettings={onOpenSettings} /> : null}
    </section>
  );
}
