// LanChatDetachedWindow — a single LanChat conversation popped into its own OS
// window (opened via `open_detached_window` with kind "lan-chat", id=convId).
//
// Unlike the session-backed detached windows, LanChat needs no credential
// handoff or reattach: all conversation state lives in the Rust backend, and
// this window simply opens its own lanChatStore instance, subscribes to the
// `lanchat://*` events, and renders the conversation thread + composer for the
// given conversation id. Closing the window is independent — the conversation
// (and its connections) persist in the backend.

import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { useLanChatStore } from "../../stores/lanChatStore";
import { useAppTheme } from "../../lib/appTheme";
import { isTauriRuntime } from "../../lib/runtime";
import { closeCurrentDetachedWindow } from "../../lib/detachWindowing";
import { MessageThread } from "../lanchat/MessageThread";
import { MessageInput } from "../lanchat/MessageInput";
import { VaultGate } from "../vault/VaultGate";

export default function LanChatDetachedWindow({ id }: { id: string }) {
  const { mode, resolvedTheme } = useAppTheme();
  const tauri = isTauriRuntime();
  const init = useLanChatStore((s) => s.init);
  const openConversation = useLanChatStore((s) => s.openConversation);
  const roster = useLanChatStore((s) => s.roster);
  const groups = useLanChatStore((s) => s.groups);

  const [title, setTitle] = useState("内网通讯");

  // Match the main window's theme handling so the popout looks consistent.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.appTheme = resolvedTheme;
    root.dataset.appThemeMode = mode;
    root.style.colorScheme = resolvedTheme;
  }, [mode, resolvedTheme]);

  // Boot the store (loads state + subscribes to events), suppress notifications
  // in this secondary window, and select the requested conversation.
  useEffect(() => {
    useLanChatStore.setState({ suppressNotifications: true });
    void (async () => {
      await init();
      await openConversation(id);
    })();
  }, [init, openConversation, id]);

  // Seed the header from the OS window title (resolved by the opener), then
  // refine from the store once roster/group data is available.
  useEffect(() => {
    if (!tauri) return;
    void getCurrentWindow()
      .title()
      .then((t) => {
        if (t) setTitle(t);
      })
      .catch(() => undefined);
  }, [tauri]);

  const resolved = (() => {
    if (id.startsWith("group:")) {
      const g = groups.find((x) => `group:${x.id}` === id);
      return g?.name;
    }
    if (id.startsWith("direct:")) {
      const peerId = id.slice("direct:".length);
      return roster.find((p) => p.id === peerId)?.name;
    }
    return undefined;
  })();
  const headerName = resolved ?? title;

  useEffect(() => {
    document.title = headerName;
  }, [headerName]);

  // OS close button: close the window directly (no reattach for LanChat).
  useEffect(() => {
    if (!tauri) return;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        event.preventDefault();
        void closeCurrentDetachedWindow().catch(() => undefined);
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, [tauri]);

  return (
    <div
      data-testid="lanchat-detached-window"
      data-conv-id={id}
      className="flex h-screen w-screen flex-col"
      style={{ background: "var(--taomni-bg)", color: "var(--taomni-text)" }}
    >
      <div
        className="flex h-9 shrink-0 items-center px-3 text-[13px] font-semibold"
        style={{
          background: "linear-gradient(to bottom,var(--taomni-titlebar-from),var(--taomni-titlebar-to))",
          borderBottom: "1px solid var(--taomni-chrome-border)",
        }}
      >
        {headerName}
      </div>
      <VaultGate
        lockedTitle="局域网聊天已锁定"
        lockedHint="需要主密码解锁。该密码与应用的密码保险库共用。"
      >
        <MessageThread />
        <MessageInput disabled={false} />
      </VaultGate>
    </div>
  );
}
