import { ChevronRight, KeyRound, Lock, Pin, PinOff, Plus, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { errorText } from "../../lib/mfa/format";
import type { MfaAccount } from "../../lib/mfa/types";
import { useAppStore } from "../../stores/appStore";
import { useMfaStore } from "../../stores/mfaStore";
import { useVaultStore } from "../../stores/vaultStore";
import { VaultSetupDialog } from "../vault/VaultSetupDialog";
import { VaultUnlockDialog } from "../vault/VaultUnlockDialog";
import { FLOATING_MFA_WIDTH } from "../../stores/app/layoutSlice";

const TICK_MS = 500;

/**
 * Bottom-left floating MFA authenticator (AC-04, TASK-04).
 *
 * Opens from the rail's `🔐 MFA` button at `left: 50px; bottom: 30px`, is freely
 * draggable (clamped to the viewport), keeps the current terminal visible, and
 * reuses the existing vault gate and TOTP/HOTP store. Expanding it opens the
 * full MFA manager tab so all existing MFA flows stay intact.
 */
export function MfaFloatingWindow({ onExpand }: { onExpand: () => void }) {
  const t = useT();
  const floating = useAppStore((s) => s.floatingMfa);
  const setPosition = useAppStore((s) => s.setFloatingMfaPosition);
  const setPinned = useAppStore((s) => s.setFloatingMfaPinned);
  const setSearch = useAppStore((s) => s.setFloatingMfaSearch);
  const close = useAppStore((s) => s.closeFloatingMfa);
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  const vaultState = useVaultStore((s) => s.state);
  const refreshVault = useVaultStore((s) => s.refresh);
  const unlockVault = useVaultStore((s) => s.unlock);
  const initVault = useVaultStore((s) => s.init);
  const accounts = useMfaStore((s) => s.accounts);
  const codes = useMfaStore((s) => s.codes);
  const status = useMfaStore((s) => s.status);
  const mfaError = useMfaStore((s) => s.error);
  const [now, setNow] = useState(() => Date.now());
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; left: number; bottom: number } | null>(null);
  const copiedTimer = useRef<number | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    void refreshVault();
  }, [refreshVault]);

  useEffect(() => {
    if (vaultState !== "unlocked") return;
    const store = useMfaStore.getState();
    if (store.status === "idle") void store.load();
    const refresh = window.setInterval(() => void store.refreshCodes(), 1000);
    return () => window.clearInterval(refresh);
  }, [vaultState]);

  useEffect(() => {
    if (!floating.open) return;
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const state = useAppStore.getState();
      if (!state.floatingMfa.open) return;
      event.stopPropagation();
      state.closeFloatingMfa();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [floating.open]);

  useEffect(() => () => {
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
  }, []);

  const visibleAccounts = useMemo(() => {
    const needle = floating.searchQuery.trim().toLowerCase();
    const list = accounts.filter((account) => !needle
      || account.issuer.toLowerCase().includes(needle)
      || account.accountName.toLowerCase().includes(needle)
      || account.group.toLowerCase().includes(needle));
    return [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.sortOrder - b.sortOrder);
  }, [accounts, floating.searchQuery]);

  if (!floating.open) return null;

  const startDrag = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      left: floating.position.left,
      bottom: floating.position.bottom,
    };
    setDragging(true);
    const onMove = (move: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      setPosition(
        drag.left + (move.clientX - drag.startX),
        drag.bottom - (move.clientY - drag.startY),
      );
    };
    const finish = () => {
      dragRef.current = null;
      setDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
  };

  const copy = async (account: MfaAccount) => {
    try {
      const code = await useMfaStore.getState().copyCode(account.id);
      if (!code) return;
      setCopiedId(account.id);
      setStatusMessage(t("platform.mfaCopied"));
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopiedId(null), 1500);
    } catch (error) {
      setStatusMessage(t("mfa.copyFailed", { error: errorText(error) }));
    }
  };

  const remainingSeconds = (account: MfaAccount) => {
    const period = account.period > 0 ? account.period : 30;
    return period - (Math.floor(now / 1000) % period);
  };

  const progress = (account: MfaAccount) => {
    const period = account.period > 0 ? account.period : 30;
    return remainingSeconds(account) / period;
  };

  return (
    <div
      data-testid="mfa-floating-window"
      data-pinned={floating.pinned || undefined}
      role="dialog"
      aria-label={t("platform.mfaTitle")}
      className="fixed flex flex-col overflow-hidden rounded-lg border shadow-2xl"
      style={{
        position: "fixed",
        left: floating.position.left,
        bottom: floating.position.bottom,
        width: FLOATING_MFA_WIDTH,
        maxHeight: "min(70vh, 520px)",
        zIndex: floating.pinned ? 960 : 950,
        borderColor: "var(--taomni-card-border)",
        background: "var(--taomni-panel-bg)",
        boxShadow: "0 18px 40px rgba(0,0,0,0.35)",
      }}
    >
      <div
        data-testid="mfa-floating-drag-handle"
        className="flex h-8 shrink-0 cursor-move items-center gap-1 border-b px-2"
        style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-card-bg)" }}
        onPointerDown={startDrag}
      >
        <KeyRound className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--taomni-accent)" }} />
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold" style={{ cursor: "move" }}>
          {t("platform.mfaTitle")}
        </span>
        <button
          type="button"
          data-testid="mfa-floating-add"
          title={t("platform.mfaAdd")}
          aria-label={t("platform.mfaAdd")}
          className="rounded p-1 hover:bg-[var(--taomni-hover)]"
          onClick={() => {
            onExpand();
            close();
          }}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          data-testid="mfa-floating-pin"
          title={floating.pinned ? t("platform.mfaUnpin") : t("platform.mfaPin")}
          aria-label={t("platform.mfaPin")}
          aria-pressed={floating.pinned}
          className="rounded p-1 hover:bg-[var(--taomni-hover)]"
          onClick={() => setPinned(!floating.pinned)}
        >
          {floating.pinned ? <Pin className="h-3.5 w-3.5" /> : <PinOff className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          data-testid="mfa-floating-expand-tab"
          title={t("platform.mfaExpand")}
          aria-label={t("platform.mfaExpand")}
          className="rounded p-1 hover:bg-[var(--taomni-hover)]"
          onClick={() => {
            onExpand();
            close();
          }}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          data-testid="mfa-floating-close"
          title={t("platform.mfaClose")}
          aria-label={t("platform.mfaClose")}
          className="rounded p-1 hover:bg-[var(--taomni-hover)]"
          onClick={() => close()}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {vaultState !== "unlocked" ? (
        <div className="flex flex-col items-start gap-2 p-3" data-testid="mfa-floating-locked">
          <div className="flex items-center gap-1.5 text-[12px] font-semibold">
            <Lock className="h-3.5 w-3.5" />
            {t("mfa.lockedTitle")}
          </div>
          <div className="text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>{t("platform.mfaLocked")}</div>
          <button
            type="button"
            data-testid="mfa-floating-unlock"
            className="taomni-btn taomni-btn-primary h-7 px-2"
            onClick={() => {
              if (vaultState === "empty") setSetupOpen(true);
              else setUnlockOpen(true);
            }}
          >
            {vaultState === "empty" ? t("vault.setupTitle") : t("vault.unlockTitle")}
          </button>
          {unlockOpen && (
            <VaultUnlockDialog
              onCancel={() => setUnlockOpen(false)}
              onSubmit={async (password) => {
                await unlockVault(password);
                setUnlockOpen(false);
              }}
            />
          )}
          {setupOpen && (
            <VaultSetupDialog
              onCancel={() => setSetupOpen(false)}
              onSubmit={async (password) => {
                await initVault(password);
                setSetupOpen(false);
              }}
            />
          )}
        </div>
      ) : (
        <>
          <div className="shrink-0 px-2 pt-2">
            <div className="relative">
              <Search className="absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2" style={{ color: "var(--taomni-text-muted)" }} />
              <input
                type="search"
                data-testid="mfa-floating-search"
                className="taomni-input h-6 w-full"
                style={{ paddingLeft: 22 }}
                aria-label={t("platform.mfaSearch")}
                placeholder={t("platform.mfaSearch")}
                value={floating.searchQuery}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2" data-testid="mfa-floating-list">
            {status === "error" && (
              <div className="px-1 py-2 text-[11px]" style={{ color: "var(--taomni-danger)" }}>{mfaError ?? "MFA error"}</div>
            )}
            {status !== "error" && visibleAccounts.length === 0 && (
              <div className="px-1 py-2 text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>{t("platform.mfaNoAccounts")}</div>
            )}
            {visibleAccounts.map((account) => {
              const code = codes[account.id]?.code ?? "------";
              const seconds = remainingSeconds(account);
              return (
                <button
                  key={account.id}
                  type="button"
                  data-testid="mfa-floating-account"
                  data-account-id={account.id}
                  data-copied={copiedId === account.id || undefined}
                  className="mb-1 flex w-full items-center justify-between gap-2 rounded border px-2 py-1.5 text-left hover:bg-[var(--taomni-hover)]"
                  style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-card-bg)" }}
                  onClick={() => void copy(account)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11.5px] font-semibold">{account.issuer || account.accountName}</span>
                    <span className="block truncate text-[10px]" style={{ color: "var(--taomni-text-muted)" }}>{account.accountName}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <span className="font-mono text-[15px] font-bold tabular-nums" data-testid="mfa-floating-code" style={{ color: "var(--taomni-accent)" }}>
                      {code.slice(0, 3)} {code.slice(3)}
                    </span>
                    <span
                      aria-hidden="true"
                      className="relative flex h-6 w-6 items-center justify-center rounded-full text-[9px] tabular-nums"
                      style={{
                        background: `conic-gradient(var(--taomni-accent) ${Math.round(progress(account) * 100)}%, var(--taomni-divider) 0)`,
                      }}
                    >
                      <span
                        className="flex h-[18px] w-[18px] items-center justify-center rounded-full"
                        style={{ background: "var(--taomni-card-bg)", color: "var(--taomni-text-muted)" }}
                      >
                        {seconds}
                      </span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="shrink-0 border-t px-2 py-1 text-[10px]" style={{ borderColor: "var(--taomni-divider)", color: "var(--taomni-text-muted)" }}>
            {t("platform.mfaCopyHint")}
          </div>
        </>
      )}
      {dragging && <div className="pointer-events-none absolute inset-0" />}
    </div>
  );
}
