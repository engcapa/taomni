// LanChatDetachedWindow — a single LanChat conversation popped into its own OS
// window (opened via `open_detached_window` with kind "lan-chat", id=convId).
//
// Unlike the session-backed detached windows, LanChat needs no credential
// handoff: all conversation state lives in the Rust backend, and this window
// simply opens its own lanChatStore instance, subscribes to the `lanchat://*`
// events, and renders the roster + conversation for the given conversation id.
// Reattach recreates the main-window LanChat tab and selects the active thread.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Hash, PanelLeft, Search, Users } from "lucide-react";

import { mergedMemberPeers, useLanChatStore } from "../../stores/lanChatStore";
import { useAppTheme } from "../../lib/appTheme";
import { broadcastReattach } from "../../lib/detachedSession";
import { isTauriRuntime } from "../../lib/runtime";
import { closeCurrentDetachedWindow } from "../../lib/detachWindowing";
import { Avatar } from "../lanchat/Avatar";
import { MessageThread } from "../lanchat/MessageThread";
import { MessageInput } from "../lanchat/MessageInput";
import { RosterList } from "../lanchat/RosterList";
import { TransferTrayButton } from "../lanchat/TransferPanel";
import { VaultGate } from "../vault/VaultGate";

export default function LanChatDetachedWindow({ id }: { id: string }) {
  const { mode, resolvedTheme } = useAppTheme();
  const tauri = isTauriRuntime();
  const init = useLanChatStore((s) => s.init);
  const openConversation = useLanChatStore((s) => s.openConversation);
  const profile = useLanChatStore((s) => s.profile);
  const roster = useLanChatStore((s) => s.roster);
  const groups = useLanChatStore((s) => s.groups);
  const conversations = useLanChatStore((s) => s.conversations);
  const activeConvId = useLanChatStore((s) => s.activeConvId);
  const segment = useLanChatStore((s) => s.segment);
  const setSegment = useLanChatStore((s) => s.setSegment);

  const [title, setTitle] = useState("内网通讯");
  const [search, setSearch] = useState("");
  const reattachingRef = useRef(false);
  const memberCount = useMemo(
    () => mergedMemberPeers(roster, conversations).length,
    [roster, conversations],
  );

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

  const displayedConvId = activeConvId ?? id;
  const resolved = (() => {
    if (displayedConvId.startsWith("group:")) {
      const g = groups.find((x) => `group:${x.id}` === displayedConvId);
      return g?.name;
    }
    if (displayedConvId.startsWith("direct:")) {
      const peerId = displayedConvId.slice("direct:".length);
      return roster.find((p) => p.id === peerId)?.name;
    }
    return undefined;
  })();
  const headerName = resolved ?? title;

  useEffect(() => {
    document.title = headerName;
  }, [headerName]);

  const requestReattach = useCallback(async () => {
    if (reattachingRef.current) return;
    reattachingRef.current = true;
    broadcastReattach("lan-chat", id, {
      activeConvId: displayedConvId,
      title: headerName,
    });
    try {
      if (tauri) {
        await closeCurrentDetachedWindow();
      } else {
        window.close();
      }
    } catch {
      try {
        if (tauri) {
          const current = getCurrentWindow();
          await current.hide().catch(() => undefined);
          await current.destroy();
        }
      } catch {
        /* noop */
      }
    }
  }, [displayedConvId, headerName, id, tauri]);

  // Treat OS close as Reattach, matching the other detached window kinds.
  useEffect(() => {
    if (!tauri) {
      const handler = () => {
        if (reattachingRef.current) return;
        broadcastReattach("lan-chat", id, {
          activeConvId: displayedConvId,
          title: headerName,
        });
      };
      window.addEventListener("beforeunload", handler);
      window.addEventListener("pagehide", handler);
      return () => {
        window.removeEventListener("beforeunload", handler);
        window.removeEventListener("pagehide", handler);
      };
    }
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        event.preventDefault();
        void requestReattach();
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, [displayedConvId, headerName, id, requestReattach, tauri]);

  return (
    <div
      data-testid="lanchat-detached-window"
      data-conv-id={displayedConvId}
      className="flex h-screen w-screen flex-col"
      style={{ background: "var(--taomni-bg)", color: "var(--taomni-text)" }}
    >
      <div
        className="flex h-9 shrink-0 items-center gap-2 px-3 text-[13px] font-semibold"
        style={{
          background: "linear-gradient(to bottom,var(--taomni-titlebar-from),var(--taomni-titlebar-to))",
          borderBottom: "1px solid var(--taomni-chrome-border)",
        }}
      >
        <span className="min-w-0 flex-1 truncate">{headerName}</span>
        <TransferTrayButton placement="bottom" />
        <button
          type="button"
          data-testid="lanchat-detached-reattach"
          title="重新附着为主窗口标签页"
          onClick={() => void requestReattach()}
          className="grid h-7 w-7 place-items-center rounded-md"
          style={{ color: "var(--taomni-text-muted)" }}
        >
          <PanelLeft className="h-4 w-4" />
        </button>
      </div>
      <VaultGate
        lockedTitle="局域网聊天已锁定"
        lockedHint="需要主密码解锁。该密码与应用的密码保险库共用。"
      >
        <div className="flex min-h-0 flex-1">
          <aside
            data-testid="lanchat-detached-roster-panel"
            className="flex w-[252px] flex-none flex-col"
            style={{
              background: "var(--taomni-panel-bg)",
              borderRight: "1px solid var(--taomni-divider)",
            }}
          >
            <div
              className="flex items-center gap-2.5 p-2.5"
              style={{ borderBottom: "1px solid var(--taomni-divider)" }}
            >
              <Avatar
                name={profile?.name ?? "我"}
                avatarBase64={profile?.avatarBase64}
                status={profile?.status ?? "online"}
                size={34}
                radius={9}
              />
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold">
                  {profile?.name ?? "我"}
                  <span style={{ color: "var(--taomni-text-muted)", fontWeight: 400 }}>
                    {" "}
                    · 本机
                  </span>
                </div>
                <div className="truncate text-[12px]" style={{ color: "var(--taomni-text-muted)" }}>
                  {profile?.signature || "内网成员列表"}
                </div>
              </div>
            </div>

            <div className="m-2 flex rounded-lg p-0.5" style={{ background: "var(--taomni-tab-inactive)" }}>
              <RosterTab active={segment === "members"} onClick={() => setSegment("members")}>
                <Users className="h-3.5 w-3.5" />
                成员 {memberCount}
              </RosterTab>
              <RosterTab active={segment === "groups"} onClick={() => setSegment("groups")}>
                <Hash className="h-3.5 w-3.5" />
                群组 {groups.length}
              </RosterTab>
            </div>

            <div className="mx-2 mb-2 flex items-center gap-1.5">
              <Search className="h-3.5 w-3.5 flex-none" style={{ color: "var(--taomni-text-muted)" }} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索成员 / 群组…"
                className="h-[26px] min-w-0 flex-1 rounded-md px-2.5 text-[12px] outline-none"
                style={{
                  border: "1px solid var(--taomni-input-border)",
                  background: "var(--taomni-input-bg)",
                  color: "var(--taomni-text)",
                }}
              />
            </div>

            <RosterList search={search} />
          </aside>

          <main className="flex min-h-0 min-w-0 flex-1 flex-col" style={{ background: "var(--taomni-bg)" }}>
            <MessageThread />
            <MessageInput disabled={false} />
          </main>
        </div>
      </VaultGate>
    </div>
  );
}

function RosterTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md py-1 text-[12px]"
      style={{
        background: active ? "var(--taomni-card-bg)" : "transparent",
        color: active ? "var(--taomni-text)" : "var(--taomni-text-muted)",
        fontWeight: active ? 600 : 400,
        boxShadow: active ? "var(--taomni-shadow-sm)" : "none",
      }}
    >
      {children}
    </button>
  );
}
