import { useEffect, useSyncExternalStore } from "react";
import { MessageList } from "./MessageList";
import { TaoComposer } from "./Composer";
import { SidePanel } from "./SidePanel";
import { TopBar } from "./TopBar";
import { BudgetCard, BrowserUnavailableCard, ErrorCard, RefusalCard, StoppedCard, VaultLockedMask } from "./states/StateCards";
import type { ChatProfile, TaoChatController, TaoChatSlots } from "./ports";

export function TaoAiChat({ controller, profile, slots, disabled = false, onOpenSettings }: { controller: TaoChatController; profile: ChatProfile; slots?: TaoChatSlots; disabled?: boolean; onOpenSettings?: () => void }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const thread = state.activeThreadId ? state.threads[state.activeThreadId] : undefined;
  const phase = state.activeThreadId ? state.runtime[state.activeThreadId]?.phase ?? "idle" : "idle";
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        controller.setSearchOpen(true);
      }
      if (event.key === "Escape" && state.ui.searchOpen) {
        event.preventDefault();
        controller.setSearchOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [controller, state.ui.searchOpen]);
  return (
    <section className="tao-ai-chat" data-testid="tao-ai-chat">
      <TopBar state={state} profile={profile} onMode={controller.setMode} onSearch={() => controller.setSearchOpen(true)} onMore={() => controller.setSidePanel(state.ui.sidePanel ? null : profile.sidePanels[0] ?? null)} slots={slots?.headerLeading} />
      <div className={`tao-home-main ${thread?.messages.length ? "has-messages" : "empty"}`}>
        <div className="tao-home-feed" data-testid="tao-home-feed">
          {thread?.messages.length ? <MessageList thread={thread} phase={phase} controller={controller} /> : <div className="tao-home-empty-stage"><div className="tao-home-greeting"><span className="tao-home-logo">T</span><div><h1>Tao 在这里</h1><p>Develop Buddy · 问、做、深研你的开发问题</p></div></div>{slots?.emptyState}</div>}
          <ErrorCard phase={phase} controller={controller} /><RefusalCard phase={phase} /><BudgetCard phase={phase} controller={controller} /><StoppedCard phase={phase} controller={controller} web={state.composer.web} />
        </div>
        <div className="tao-home-composer-dock"><div className="tao-home-composer-context">{slots?.composerContext}</div><TaoComposer controller={controller} state={state} disabled={disabled} />{slots?.belowComposer}</div>
      </div>
      <VaultLockedMask phase={phase} />
      <SidePanel state={state} profile={profile} controller={controller}>{slots?.sidePanels}</SidePanel>
      {disabled && !slots?.emptyState ? <BrowserUnavailableCard onOpenSettings={onOpenSettings} /> : null}
    </section>
  );
}
