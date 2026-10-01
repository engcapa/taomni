import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Camera, Image as ImageIcon, KeyRound, Plus, ScanLine, Search } from "lucide-react";
import { useT } from "../../lib/i18n";
import { confirmAppDialog } from "../../lib/appDialogs";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { errorText } from "../../lib/mfa/format";
import { accountLabel, parseImportTexts, type MfaParsedItem } from "../../lib/mfa/otpauth";
import { accountGroups, visibleAccounts } from "../../lib/mfa/sort";
import { decodeImageFiles, imageFilesFromTransfer } from "../../lib/mfa/sources";
import { MFA_SORT_MODES, MFA_UNGROUPED, type MfaAccount, type MfaSortMode } from "../../lib/mfa/types";
import { useMfaStore } from "../../stores/mfaStore";
import { MfaAccountRow } from "./MfaAccountRow";
import { MfaAddDialog, type MfaAddMode } from "./MfaAddDialog";
import { MfaEditDialog } from "./MfaEditDialog";
import { MfaQrDialog } from "./MfaQrDialog";

const TICK_MS = 500;
const COPIED_HIGHLIGHT_MS = 1500;

function focusCode(list: HTMLElement | null, index: number) {
  const codes = list?.querySelectorAll<HTMLButtonElement>('[data-testid="mfa-account-code"]');
  if (!codes || codes.length === 0) return;
  codes[Math.max(0, Math.min(codes.length - 1, index))]?.focus();
}

export function MfaPanel({ onStatusMessage }: { onStatusMessage?: (message: string) => void }) {
  const t = useT();
  const ctx = useContextMenu();
  const status = useMfaStore((s) => s.status);
  const error = useMfaStore((s) => s.error);
  const errorCode = useMfaStore((s) => s.errorCode);
  const accounts = useMfaStore((s) => s.accounts);
  const codes = useMfaStore((s) => s.codes);
  const prefs = useMfaStore((s) => s.prefs);
  const query = useMfaStore((s) => s.query);
  const lastCopied = useMfaStore((s) => s.lastCopied);
  const store = useMfaStore.getState;
  const [now, setNow] = useState(() => Date.now());
  const [announcement, setAnnouncement] = useState("");
  const [addMode, setAddMode] = useState<MfaAddMode | null>(null);
  const [addItems, setAddItems] = useState<MfaParsedItem[] | null>(null);
  const [editing, setEditing] = useState<MfaAccount | null>(null);
  const [qrAccount, setQrAccount] = useState<MfaAccount | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const lastRefreshRef = useRef(0);

  const announce = useCallback(
    (message: string) => {
      setAnnouncement(message);
      onStatusMessage?.(message);
    },
    [onStatusMessage],
  );

  useEffect(() => {
    void store().load();
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [store]);

  // Refresh once any TOTP window has rolled over (at most once per second).
  useEffect(() => {
    if (status !== "ready") return;
    const expired = accounts.some((account) => account.kind === "totp" && (codes[account.id]?.validUntilMs ?? 0) <= now);
    if (expired && now - lastRefreshRef.current >= 1000) {
      lastRefreshRef.current = now;
      void store().refreshCodes().catch(() => undefined);
    }
  }, [accounts, codes, now, status, store]);

  const visible = useMemo(
    () => visibleAccounts(accounts, { query, group: prefs.groupFilter, sortMode: prefs.sortMode }),
    [accounts, prefs.groupFilter, prefs.sortMode, query],
  );
  const groups = useMemo(() => accountGroups(accounts), [accounts]);
  const reorderable = prefs.sortMode === "custom" && !query.trim();

  const copy = async (account: MfaAccount, which: "current" | "next") => {
    try {
      const digits = await store().copyCode(account.id, which);
      if (digits) announce(t(which === "next" ? "mfa.copiedNext" : "mfa.copied", { name: accountLabel(account) }));
    } catch (err) {
      announce(t("mfa.copyFailed", { error: errorText(err) }));
    }
  };

  const remove = async (account: MfaAccount) => {
    const name = accountLabel(account);
    const confirmed = await confirmAppDialog({ message: t("mfa.confirmDelete", { name }), confirmLabel: t("common.delete"), danger: true });
    if (!confirmed) return;
    try {
      await store().deleteAccount(account.id);
      announce(t("mfa.deleted", { name }));
    } catch (err) {
      announce(t("mfa.errorPrefix", { error: errorText(err) }));
    }
  };

  const move = (account: MfaAccount, target: MfaAccount | undefined) => {
    if (!target) return;
    void store().moveAccount(account.id, target.id).catch((err) => announce(t("mfa.errorPrefix", { error: errorText(err) })));
  };

  const canMove = (index: number, delta: -1 | 1) => {
    const neighbor = visible[index + delta];
    return reorderable && !!neighbor && neighbor.pinned === visible[index].pinned;
  };

  const openMenu = (event: React.MouseEvent, account: MfaAccount, index: number) => {
    const items: MenuItem[] = [
      { label: t("mfa.menuEdit"), testId: "mfa-menu-edit", onClick: () => setEditing(account) },
      { label: t("mfa.menuShowQr"), testId: "mfa-menu-qr", onClick: () => setQrAccount(account) },
      {
        label: account.pinned ? t("mfa.unpin") : t("mfa.pin"),
        testId: "mfa-menu-pin",
        onClick: () => void store().togglePin(account.id).catch(() => undefined),
      },
      { label: "", separator: true, onClick: () => {} },
      {
        label: reorderable ? t("mfa.menuMoveUp") : `${t("mfa.menuMoveUp")} — ${t("mfa.moveNeedsCustom")}`,
        testId: "mfa-menu-move-up",
        disabled: !canMove(index, -1),
        onClick: () => move(account, visible[index - 1]),
      },
      {
        label: reorderable ? t("mfa.menuMoveDown") : `${t("mfa.menuMoveDown")} — ${t("mfa.moveNeedsCustom")}`,
        testId: "mfa-menu-move-down",
        disabled: !canMove(index, 1),
        onClick: () => move(account, visible[index + 1]),
      },
      { label: "", separator: true, onClick: () => {} },
      { label: t("mfa.menuDelete"), testId: "mfa-menu-delete", danger: true, onClick: () => void remove(account) },
    ];
    ctx.show(event, items);
  };

  const resetStore = async () => {
    if (!(await confirmAppDialog({ message: t("mfa.confirmReset"), confirmLabel: t("mfa.resetStore"), danger: true }))) return;
    if (!(await confirmAppDialog({ message: t("mfa.confirmResetAgain"), confirmLabel: t("mfa.resetStore"), danger: true }))) return;
    try {
      await store().resetStore();
      announce(t("mfa.resetDone"));
    } catch (err) {
      announce(t("mfa.errorPrefix", { error: errorText(err) }));
    }
  };

  // A screenshot pasted onto the tab itself jumps straight to the import preview.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (addMode || editing || qrAccount) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      const active = document.activeElement;
      if (active && active !== document.body && !panelRef.current?.contains(active)) return;
      const files = imageFilesFromTransfer(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      void decodeImageFiles(files)
        .then((texts) => {
          const { items } = parseImportTexts(texts);
          if (items.length === 0) {
            announce(texts.length === 0 ? t("mfa.imageNoQr") : t("mfa.imageNotOtp"));
            return;
          }
          setAddItems(items);
          setAddMode("image");
        })
        .catch((err) => announce(t("mfa.imageInvalid", { error: errorText(err) })));
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addMode, announce, editing, qrAccount, t]);

  const openAdd = (mode: MfaAddMode) => {
    setAddItems(null);
    setAddMode(mode);
  };
  const groupOptions = prefs.groupFilter && prefs.groupFilter !== MFA_UNGROUPED && !groups.includes(prefs.groupFilter)
    ? [...groups, prefs.groupFilter]
    : groups;
  const keyError = status === "error" && (errorCode === "MFA_KEY_MISSING" || errorCode === "MFA_KEY_MISMATCH");

  return (
    <div ref={panelRef} data-testid="mfa-panel" className="flex h-full min-h-0 flex-col" style={{ background: "var(--taomni-bg)", color: "var(--taomni-text)" }}>
      {ctx.render}
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2" style={{ borderColor: "var(--taomni-divider)" }}>
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2" style={{ color: "var(--taomni-text-muted)" }} />
          <input
            type="search"
            data-testid="mfa-search"
            aria-label={t("mfa.searchLabel")}
            placeholder={t("mfa.searchPlaceholder")}
            className="taomni-input h-7 w-full text-[12px]"
            style={{ paddingLeft: 28 }}
            value={query}
            onChange={(event) => store().setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && visible[0]) {
                event.preventDefault();
                void copy(visible[0], "current");
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                focusCode(listRef.current, 0);
              }
            }}
          />
        </div>
        <label className="flex items-center gap-1 text-[12px]" style={{ color: "var(--taomni-text-muted)" }}>
          {t("mfa.groupFilterLabel")}
          <select
            data-testid="mfa-group-filter"
            className="taomni-input h-7 text-[12px]"
            value={prefs.groupFilter}
            onChange={(event) => void store().setGroupFilter(event.target.value).catch(() => undefined)}
          >
            <option value="">{t("mfa.groupAll")}</option>
            {groupOptions.map((group) => (
              <option key={group} value={group}>{group}</option>
            ))}
            <option value={MFA_UNGROUPED}>{t("mfa.groupNone")}</option>
          </select>
        </label>
        <label className="flex items-center gap-1 text-[12px]" style={{ color: "var(--taomni-text-muted)" }}>
          {t("mfa.sortLabel")}
          <select
            data-testid="mfa-sort-mode"
            className="taomni-input h-7 text-[12px]"
            value={prefs.sortMode}
            onChange={(event) => void store().setSortMode(event.target.value as MfaSortMode).catch(() => undefined)}
          >
            {MFA_SORT_MODES.map((mode) => (
              <option key={mode} value={mode}>{t(`mfa.sort.${mode}`)}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          data-testid="mfa-add"
          aria-label={t("mfa.addLabel")}
          className="inline-flex h-7 items-center gap-1 rounded px-3 text-[12px] text-white"
          style={{ background: "var(--taomni-accent)" }}
          onClick={() => openAdd("secret")}
        >
          <Plus className="h-3.5 w-3.5" />
          {t("mfa.add")}
        </button>
      </div>
      {status === "ready" && error ? (
        <div data-testid="mfa-error" role="alert" className="flex items-center gap-2 border-b px-3 py-1.5 text-[12px]" style={{ borderColor: "var(--taomni-divider)", color: "var(--taomni-error, #c33)" }}>
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 truncate">{t("mfa.errorPrefix", { error })}</span>
          <button type="button" className="rounded px-2 hover:bg-[var(--taomni-hover)]" onClick={() => store().clearError()}>
            {t("mfa.close")}
          </button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {keyError ? (
          <div data-testid="mfa-key-error" role="alert" className="mx-auto mt-10 max-w-[520px] space-y-3 px-6 text-center text-[12px]">
            <AlertTriangle className="mx-auto h-8 w-8" style={{ color: "var(--taomni-error, #c33)" }} />
            <div className="text-[14px] font-semibold">{t("mfa.keyErrorTitle")}</div>
            <div style={{ color: "var(--taomni-text-muted)" }}>{errorCode === "MFA_KEY_MISSING" ? t("mfa.keyMissing") : t("mfa.keyMismatch")}</div>
            <button type="button" data-testid="mfa-reset-store" className="rounded px-3 py-1.5 text-white" style={{ background: "var(--taomni-error, #c33)" }} onClick={() => void resetStore()}>
              {t("mfa.resetStore")}
            </button>
          </div>
        ) : status === "error" ? (
          <div data-testid="mfa-load-error" role="alert" className="mx-auto mt-10 max-w-[520px] space-y-3 px-6 text-center text-[12px]">
            <div style={{ color: "var(--taomni-error, #c33)" }}>{t("mfa.errorPrefix", { error: error ?? "" })}</div>
            <button type="button" data-testid="mfa-retry" className="rounded border px-3 py-1 hover:bg-[var(--taomni-hover)]" style={{ borderColor: "var(--taomni-input-border)" }} onClick={() => void store().load()}>
              {t("mfa.retry")}
            </button>
          </div>
        ) : status !== "ready" && accounts.length === 0 ? (
          <div data-testid="mfa-loading" className="mt-10 text-center text-[12px]" style={{ color: "var(--taomni-text-muted)" }}>
            {t("mfa.loading")}
          </div>
        ) : accounts.length === 0 ? (
          <div data-testid="mfa-empty" className="mx-auto mt-10 max-w-[520px] space-y-3 px-6 text-center">
            <KeyRound className="mx-auto h-8 w-8" style={{ color: "var(--taomni-text-muted)" }} />
            <div className="text-[14px] font-semibold">{t("mfa.emptyTitle")}</div>
            <div className="text-[12px]" style={{ color: "var(--taomni-text-muted)" }}>{t("mfa.emptyHint")}</div>
            <div className="flex flex-wrap justify-center gap-2">
              {([
                ["secret", KeyRound, "mfa.modeSecret"],
                ["image", ImageIcon, "mfa.modeImage"],
                ["screen", ScanLine, "mfa.modeScreen"],
                ["camera", Camera, "mfa.modeCamera"],
              ] as const).map(([mode, Icon, label]) => (
                <button
                  key={mode}
                  type="button"
                  data-testid={`mfa-empty-add-${mode}`}
                  className="inline-flex items-center gap-1 rounded border px-3 py-1.5 text-[12px] hover:bg-[var(--taomni-hover)]"
                  style={{ borderColor: "var(--taomni-input-border)" }}
                  onClick={() => openAdd(mode)}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t(label)}
                </button>
              ))}
            </div>
          </div>
        ) : visible.length === 0 ? (
          <div data-testid="mfa-no-results" className="mt-10 text-center text-[12px]" style={{ color: "var(--taomni-text-muted)" }}>
            {t("mfa.noResults")}
          </div>
        ) : (
          <ul ref={listRef} data-testid="mfa-list" aria-label={t("mfa.title")}>
            {visible.map((account, index) => (
              <MfaAccountRow
                key={account.id}
                account={account}
                code={codes[account.id]}
                now={now}
                copied={lastCopied?.id === account.id && now - lastCopied.at < COPIED_HIGHLIGHT_MS}
                reorderable={reorderable}
                onCopy={(which) => void copy(account, which)}
                onHotpNext={() => void store().hotpNext(account.id).catch((err) => announce(t("mfa.errorPrefix", { error: errorText(err) })))}
                onTogglePin={() => void store().togglePin(account.id).catch(() => undefined)}
                onMenu={(event) => openMenu(event, account, index)}
                onDropAccount={(movingId) => {
                  void store().moveAccount(movingId, account.id).catch(() => undefined);
                }}
                onCodeKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    focusCode(listRef.current, index + 1);
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    focusCode(listRef.current, index - 1);
                  }
                }}
              />
            ))}
          </ul>
        )}
      </div>
      <div
        data-testid="mfa-status"
        role="status"
        aria-live="polite"
        className="min-h-[26px] border-t px-3 py-1 text-[12px]"
        style={{ borderColor: "var(--taomni-divider)", color: "var(--taomni-text-muted)" }}
      >
        {announcement}
      </div>
      {addMode ? (
        <MfaAddDialog
          initialMode={addMode}
          initialItems={addItems}
          onClose={() => {
            setAddMode(null);
            setAddItems(null);
          }}
          onAdded={(count) => {
            setAddMode(null);
            setAddItems(null);
            announce(t("mfa.added", { count }));
          }}
        />
      ) : null}
      {editing ? (
        <MfaEditDialog
          account={editing}
          groups={groups}
          onClose={() => setEditing(null)}
          onSaved={(account) => {
            setEditing(null);
            announce(t("mfa.saved", { name: accountLabel(account) }));
          }}
        />
      ) : null}
      {qrAccount ? <MfaQrDialog account={qrAccount} onClose={() => setQrAccount(null)} /> : null}
    </div>
  );
}
