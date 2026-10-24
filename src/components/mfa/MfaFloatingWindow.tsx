import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Pin, PinOff, Search, X } from "lucide-react";
import { MfaCountdown } from "./MfaCountdown";
import { VaultGate } from "../vault/VaultGate";
import { useT } from "../../lib/i18n";
import { useAppStore } from "../../stores/appStore";
import { useMfaStore } from "../../stores/mfaStore";

/**
 * Bottom-left floating MFA verifier (v6.1 TASK-04 / DEC-03): a draggable,
 * vault-gated mini window anchored at `left: 50px; bottom: 30px`. Clicking a
 * card copies its current code; the header offers pin, expand-to-full-tab
 * and close. The full `mfa-tab` management page stays available via Tools.
 */
export function MfaFloatingWindow({ onExpandTab }: { onExpandTab?: () => void }) {
  const t = useT();
  const floatingMfa = useAppStore((s) => s.floatingMfa);
  const setFloatingMfaOpen = useAppStore((s) => s.setFloatingMfaOpen);
  const setFloatingMfaPinned = useAppStore((s) => s.setFloatingMfaPinned);
  const setFloatingMfaPosition = useAppStore((s) => s.setFloatingMfaPosition);
  const setFloatingMfaSearchQuery = useAppStore((s) => s.setFloatingMfaSearchQuery);

  const dragStateRef = useRef<{ startLeft: number; startBottom: number; startX: number; startY: number } | null>(null);

  useEffect(() => {
    if (!floatingMfa.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || floatingMfa.pinned) return;
      event.preventDefault();
      event.stopPropagation();
      setFloatingMfaOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [floatingMfa.open, floatingMfa.pinned, setFloatingMfaOpen]);

  if (!floatingMfa.open || typeof document === "undefined") return null;

  const onDragStart = (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragStateRef.current = {
      startLeft: floatingMfa.position.left,
      startBottom: floatingMfa.position.bottom,
      startX: event.clientX,
      startY: event.clientY,
    };
    const onMove = (moveEvent: MouseEvent) => {
      const drag = dragStateRef.current;
      if (!drag) return;
      const deltaLeft = moveEvent.clientX - drag.startX;
      const deltaBottom = drag.startY - moveEvent.clientY;
      setFloatingMfaPosition(drag.startLeft + deltaLeft, drag.startBottom + deltaBottom);
    };
    const onUp = () => {
      dragStateRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return createPortal(
    <div
      data-testid="mfa-floating-window"
      data-pinned={floatingMfa.pinned || undefined}
      role="dialog"
      aria-label={t("sidebar.railMfa")}
      className="fixed flex flex-col rounded-lg border shadow-2xl"
      style={{
        left: `${floatingMfa.position.left}px`,
        bottom: `${floatingMfa.position.bottom}px`,
        width: "310px",
        zIndex: floatingMfa.pinned ? 1200 : 950,
        background: "var(--taomni-bg)",
        borderColor: "var(--taomni-card-border)",
        color: "var(--taomni-text)",
      }}
    >
      <div
        data-testid="mfa-floating-drag-handle"
        className="flex h-7 shrink-0 cursor-move items-center gap-2 rounded-t-lg border-b px-2"
        style={{ background: "var(--taomni-panel-bg)", borderColor: "var(--taomni-divider)" }}
        onMouseDown={onDragStart}
        onDoubleClick={() => setFloatingMfaPosition(50, 30)}
      >
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">🔐 {t("sidebar.railMfa")}</span>
        <button
          type="button"
          data-testid="mfa-floating-pin"
          title={floatingMfa.pinned ? "Unpin" : "Pin on top"}
          className="rounded p-1 hover:bg-[var(--taomni-hover)]"
          onClick={() => setFloatingMfaPinned(!floatingMfa.pinned)}
        >
          {floatingMfa.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          data-testid="mfa-floating-expand-tab"
          title="Expand"
          className="rounded p-1 hover:bg-[var(--taomni-hover)]"
          onClick={() => {
            setFloatingMfaOpen(false);
            onExpandTab?.();
          }}
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          data-testid="mfa-floating-close"
          title={t("common.close")}
          className="rounded p-1 hover:bg-[var(--taomni-hover)]"
          onClick={() => setFloatingMfaOpen(false)}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <VaultGate reason={t("mfa.unlockReason")} lockedTitle={t("mfa.lockedTitle")} lockedHint={t("mfa.lockedHint")}>
        <MfaFloatingList searchQuery={floatingMfa.searchQuery} onSearchQueryChange={setFloatingMfaSearchQuery} />
      </VaultGate>
    </div>,
    document.body,
  );
}

function MfaFloatingList({
  searchQuery,
  onSearchQueryChange,
}: {
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
}) {
  const t = useT();
  const { accounts, codes, status, load, refreshCodes, copyCode } = useMfaStore();
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (status === "idle") void load();
  }, [status, load]);

  // Keep codes fresh on a 500ms tick while mounted (mirrors MfaPanel).
  useEffect(() => {
    const timer = window.setInterval(() => {
      const stale = accounts.some((account) => {
        const code = codes[account.id];
        return !code || !code.validUntilMs || code.validUntilMs - Date.now() < 5_000;
      });
      if (stale) void refreshCodes();
    }, 500);
    return () => window.clearInterval(timer);
  }, [accounts, codes, refreshCodes]);

  const filtered = accounts.filter((account) => {
    if (!searchQuery.trim()) return true;
    const needle = searchQuery.trim().toLowerCase();
    return (account.issuer || "").toLowerCase().includes(needle)
      || (account.accountName || "").toLowerCase().includes(needle);
  });

  return (
    <div className="flex min-h-0 flex-col">
      <div className="relative m-1.5">
        <Search className="absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2" style={{ color: "var(--taomni-text-muted)" }} />
        <input
          type="search"
          data-testid="mfa-floating-search"
          aria-label={t("mfa.searchPlaceholder")}
          className="taomni-input w-full"
          style={{ paddingLeft: "22px" }}
          placeholder={t("mfa.searchPlaceholder")}
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
        />
      </div>
      <div data-testid="mfa-floating-list" className="max-h-[300px] min-h-[80px] overflow-y-auto px-1.5 pb-1.5">
        {status === "loading" && accounts.length === 0 ? (
          <div data-testid="mfa-floating-loading" className="px-2 py-4 text-center text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
            {t("mfa.loading")}
          </div>
        ) : filtered.length === 0 ? (
          <div data-testid="mfa-floating-empty" className="px-2 py-4 text-center text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
            {t("mfa.noResults")}
          </div>
        ) : (
          filtered.map((account) => {
            const code = codes[account.id];
            const digits = code?.code ?? "······";
            const remaining = code?.validUntilMs
              ? Math.max(0, Math.round((code.validUntilMs - Date.now()) / 1000))
              : 0;
            return (
              <button
                key={account.id}
                type="button"
                data-testid="mfa-floating-account"
                data-account-id={account.id}
                title={t("mfa.copyCode", { name: account.issuer || account.accountName })}
                className="mb-1 flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left hover:bg-[var(--taomni-hover)]"
                style={{ borderColor: "var(--taomni-divider)" }}
                onClick={() => {
                  void copyCode(account.id, "current");
                  setCopiedId(account.id);
                  window.setTimeout(() => setCopiedId((current) => (current === account.id ? null : current)), 1500);
                }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11.5px] font-semibold">{account.issuer || account.accountName}</span>
                  <span className="block truncate text-[10px]" style={{ color: "var(--taomni-text-muted)" }}>{account.accountName}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className="font-mono text-[15px] font-bold tracking-wider" style={{ color: "var(--taomni-accent)" }}>
                    {digits.slice(0, 3)} {digits.slice(3)}{copiedId === account.id ? " ✓" : ""}
                  </span>
                  <MfaCountdown remaining={remaining} period={account.period || 30} />
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
