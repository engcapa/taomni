// LanChatDetachedWindow — a single LanChat conversation popped into its own OS
// window (opened via `open_detached_window` with kind "lan-chat", id=convId).
// LanChatDetachedWindow — a single LanChat conversation popped into its own OS
// window (opened via `open_detached_window` with kind "lan-chat", id=convId).
//
// Unlike the session-backed detached windows, LanChat needs no credential
// handoff: all conversation state lives in the Rust backend, and this window
// simply opens its own lanChatStore instance, subscribes to the `lanchat://*`
// events, and renders the roster + conversation for the given conversation id.
// Reattach recreates the main-window LanChat tab and selects the active thread.
// Closing the popout closes this window only; reattach is an explicit titlebar action.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronLeft, ChevronRight, Hash, PanelLeft, Search, Users } from "lucide-react";

import { mergedMemberPeers, useLanChatStore } from "../../stores/lanChatStore";
import { useAppTheme } from "../../lib/appTheme";
import { broadcastReattach, clearDetachedHandoff } from "../../lib/detachedSession";
import { isTauriRuntime } from "../../lib/runtime";
import { closeCurrentDetachedWindow } from "../../lib/detachWindowing";
import type { LanProfile } from "../../types";
import { Avatar } from "../lanchat/Avatar";
import { MessageThread } from "../lanchat/MessageThread";
import { MessageInput } from "../lanchat/MessageInput";
import { RosterList, matchesMemberStatus, type MemberStatusFilter } from "../lanchat/RosterList";
import { VaultGate } from "../vault/VaultGate";

const DETACHED_ROSTER_WIDTH_KEY = "taomni.lanchat.detachedRosterWidth.v1";
const DETACHED_ROSTER_COLLAPSED_KEY = "taomni.lanchat.detachedRosterCollapsed.v1";
const DETACHED_ROSTER_DEFAULT_WIDTH = 252;
const DETACHED_ROSTER_MIN_WIDTH = 156;
const DETACHED_ROSTER_MAX_WIDTH = 560;
const DETACHED_ROSTER_COLLAPSE_WIDTH = 132;

function clampDetachedRosterWidth(width: number): number {
  return Math.max(DETACHED_ROSTER_MIN_WIDTH, Math.min(DETACHED_ROSTER_MAX_WIDTH, Math.round(width)));
}

function loadDetachedRosterWidth(): number {
  try {
    const raw = window.localStorage.getItem(DETACHED_ROSTER_WIDTH_KEY);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? clampDetachedRosterWidth(parsed) : DETACHED_ROSTER_DEFAULT_WIDTH;
  } catch {
    return DETACHED_ROSTER_DEFAULT_WIDTH;
  }
}

function loadDetachedRosterCollapsed(): boolean {
  try {
    return window.localStorage.getItem(DETACHED_ROSTER_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

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
  const [memberStatusFilter, setMemberStatusFilter] = useState<MemberStatusFilter>("active");
  const [rosterWidth, setRosterWidth] = useState(loadDetachedRosterWidth);
  const [rosterCollapsed, setRosterCollapsed] = useState(loadDetachedRosterCollapsed);
  const reattachingRef = useRef(false);
  const memberCount = useMemo(
    () =>
      mergedMemberPeers(roster, conversations).filter((peer) =>
        matchesMemberStatus(peer, memberStatusFilter),
      ).length,
    [roster, conversations, memberStatusFilter],
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

  useEffect(() => {
    try {
      window.localStorage.setItem(DETACHED_ROSTER_WIDTH_KEY, String(rosterWidth));
    } catch {
      /* ignore */
    }
  }, [rosterWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem(DETACHED_ROSTER_COLLAPSED_KEY, rosterCollapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [rosterCollapsed]);

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

  // Handle close events
  useEffect(() => {
    if (!tauri) {
      const handler = () => {
        clearDetachedHandoff("lan-chat", id);
      };
      window.addEventListener("beforeunload", handler);
      window.addEventListener("pagehide", handler);
      return () => {
        window.removeEventListener("beforeunload", handler);
        window.removeEventListener("pagehide", handler);
      };
    }
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (reattachingRef.current) return;
        // Native OS close: prevent default Tauri destroy and close without reattaching
        event.preventDefault();
        clearDetachedHandoff("lan-chat", id);
        void closeCurrentDetachedWindow().catch(() => undefined);
      })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [id, tauri]);

  const startRosterResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (rosterCollapsed) return;
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = rosterWidth;
      const prevCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (moveEvent: PointerEvent) => {
        const nextWidth = startWidth + moveEvent.clientX - startX;
        if (nextWidth <= DETACHED_ROSTER_COLLAPSE_WIDTH) {
          setRosterCollapsed(true);
          return;
        }
        setRosterCollapsed(false);
        setRosterWidth(clampDetachedRosterWidth(nextWidth));
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp, { once: true });
    },
    [rosterCollapsed, rosterWidth],
  );

  const startRosterExpandResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!rosterCollapsed) return;
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = Math.max(rosterWidth, DETACHED_ROSTER_MIN_WIDTH);
      const prevCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (moveEvent: PointerEvent) => {
        const nextWidth = startWidth + moveEvent.clientX - startX;
        if (nextWidth <= DETACHED_ROSTER_COLLAPSE_WIDTH) return;
        setRosterCollapsed(false);
        setRosterWidth(clampDetachedRosterWidth(nextWidth));
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp, { once: true });
    },
    [rosterCollapsed, rosterWidth],
  );

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
          {rosterCollapsed ? (
            <DetachedRosterRibbon
              profile={profile}
              memberCount={memberCount}
              groupCount={groups.length}
              onExpand={() => setRosterCollapsed(false)}
              onOpenMembers={() => {
                setSegment("members");
                setRosterCollapsed(false);
              }}
              onOpenGroups={() => {
                setSegment("groups");
                setRosterCollapsed(false);
              }}
            />
          ) : (
            <aside
              data-testid="lanchat-detached-roster-panel"
              className="flex flex-none flex-col"
              style={{
                width: rosterWidth,
                background: "var(--taomni-panel-bg)",
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
                <div className="min-w-0 flex-1">
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
                <button
                  type="button"
                  data-testid="lanchat-detached-roster-collapse"
                  title="收起成员栏"
                  onClick={() => setRosterCollapsed(true)}
                  className="grid h-7 w-7 flex-none place-items-center rounded-md"
                  style={{ color: "var(--taomni-text-muted)" }}
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
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
              {segment === "members" ? (
                <div className="mx-2 mb-1">
                  <DetachedStatusFilter value={memberStatusFilter} onChange={setMemberStatusFilter} />
                </div>
              ) : null}

              <RosterList search={search} statusFilter={memberStatusFilter} />
            </aside>
          )}

          {rosterCollapsed ? (
            <div
              data-testid="lanchat-detached-roster-expand-resize-handle"
              title="拖动展开成员栏"
              role="separator"
              aria-orientation="vertical"
              onPointerDown={startRosterExpandResize}
              onDoubleClick={() => setRosterCollapsed(false)}
              className="group relative w-1.5 flex-none cursor-col-resize"
              style={{ background: "transparent" }}
            >
              <div
                className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors group-hover:w-1"
                style={{ background: "var(--taomni-divider)" }}
              />
            </div>
          ) : (
            <div
              data-testid="lanchat-detached-roster-resize-handle"
              title="拖动调整成员栏宽度，拖到最左收起为 ribbon，双击恢复默认"
              role="separator"
              aria-orientation="vertical"
              aria-valuemin={DETACHED_ROSTER_MIN_WIDTH}
              aria-valuemax={DETACHED_ROSTER_MAX_WIDTH}
              aria-valuenow={rosterWidth}
              onPointerDown={startRosterResize}
              onDoubleClick={() => setRosterWidth(DETACHED_ROSTER_DEFAULT_WIDTH)}
              className="group relative w-1.5 flex-none cursor-col-resize"
              style={{ background: "transparent" }}
            >
              <div
                className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors group-hover:w-1"
                style={{ background: "var(--taomni-divider)" }}
              />
            </div>
          )}

          <main className="flex min-h-0 min-w-0 flex-1 flex-col" style={{ background: "var(--taomni-bg)" }}>
            <MessageThread />
            <MessageInput disabled={false} />
          </main>
        </div>
      </VaultGate>
    </div>
  );
}

function DetachedRosterRibbon({
  profile,
  memberCount,
  groupCount,
  onExpand,
  onOpenMembers,
  onOpenGroups,
}: {
  profile: LanProfile | null;
  memberCount: number;
  groupCount: number;
  onExpand: () => void;
  onOpenMembers: () => void;
  onOpenGroups: () => void;
}) {
  return (
    <aside
      data-testid="lanchat-detached-roster-ribbon"
      className="flex w-[34px] flex-none flex-col items-center gap-1.5 py-1.5"
      style={{ background: "var(--taomni-panel-bg)" }}
    >
      <button
        type="button"
        data-testid="lanchat-detached-roster-expand"
        title="展开成员栏"
        onClick={onExpand}
        className="grid h-6 w-6 place-items-center rounded-md"
        style={{ color: "var(--taomni-text-muted)" }}
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
      <button type="button" title="个人资料" onClick={onOpenMembers} className="grid h-7 w-7 place-items-center">
        <Avatar
          name={profile?.name ?? "我"}
          avatarBase64={profile?.avatarBase64}
          status={profile?.status ?? "online"}
          size={26}
          radius={7}
        />
      </button>
      <div className="h-px w-5" style={{ background: "var(--taomni-divider)" }} />
      <button
        type="button"
        title={`成员 ${memberCount}`}
        onClick={onOpenMembers}
        className="grid h-6 w-6 place-items-center rounded-md"
        style={{ color: "var(--taomni-text-muted)" }}
      >
        <Users className="h-3.5 w-3.5" />
      </button>
      <div
        className="rounded-full px-1 text-[9px] font-semibold leading-3.5"
        style={{ background: "var(--taomni-hover)", color: "var(--taomni-text-muted)" }}
      >
        {memberCount}
      </div>
      <button
        type="button"
        title={`群组 ${groupCount}`}
        onClick={onOpenGroups}
        className="grid h-6 w-6 place-items-center rounded-md text-[11px] font-semibold"
        style={{ color: "var(--taomni-text-muted)" }}
      >
        #
      </button>
    </aside>
  );
}

function DetachedStatusFilter({
  value,
  onChange,
}: {
  value: MemberStatusFilter;
  onChange: (value: MemberStatusFilter) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as MemberStatusFilter)}
      title="按状态过滤成员"
      className="h-[24px] w-full rounded-md px-2 text-[11px] outline-none"
      style={{
        border: "1px solid var(--taomni-input-border)",
        background: "var(--taomni-input-bg)",
        color: "var(--taomni-text-muted)",
      }}
    >
      <option value="active">隐藏离线</option>
      <option value="all">全部成员</option>
      <option value="online">仅在线</option>
      <option value="away">仅离开</option>
      <option value="busy">仅忙碌</option>
      <option value="offline">仅离线</option>
    </select>
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
