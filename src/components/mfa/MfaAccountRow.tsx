import { useRef, useState } from "react";
import { Copy, GripVertical, MoreHorizontal, RotateCw, Star } from "lucide-react";
import { useT } from "../../lib/i18n";
import { startCustomDrag, useCustomDropTarget } from "../../lib/customDnD";
import { formatCode, remainingSeconds } from "../../lib/mfa/format";
import { accountLabel } from "../../lib/mfa/otpauth";
import type { MfaAccount, MfaCode } from "../../lib/mfa/types";
import { MfaCountdown } from "./MfaCountdown";

export const MFA_DRAG_MIME = "taomni/mfa-account";
/** Show the upcoming TOTP code once this few seconds remain. */
export const MFA_NEXT_CODE_SECONDS = 10;

export interface MfaAccountRowProps {
  account: MfaAccount;
  code: MfaCode | undefined;
  now: number;
  copied: boolean;
  reorderable: boolean;
  onCopy: (which: "current" | "next") => void;
  onHotpNext: () => void;
  onTogglePin: () => void;
  onMenu: (event: React.MouseEvent) => void;
  onDropAccount: (movingId: string) => void;
  onCodeKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}

export function MfaAccountRow({
  account,
  code,
  now,
  copied,
  reorderable,
  onCopy,
  onHotpNext,
  onTogglePin,
  onMenu,
  onDropAccount,
  onCodeKeyDown,
}: MfaAccountRowProps) {
  const t = useT();
  const rowRef = useRef<HTMLLIElement>(null);
  const [dropActive, setDropActive] = useState(false);
  const name = accountLabel(account);
  const remaining = remainingSeconds(code?.validUntilMs ?? null, now);
  const showNext = account.kind === "totp" && !!code?.nextCode && remaining <= MFA_NEXT_CODE_SECONDS;

  useCustomDropTarget(rowRef, {
    accepts: (data) => reorderable && data.mime === MFA_DRAG_MIME && data.payload !== account.id,
    onDragEnter: () => setDropActive(true),
    onDragLeave: () => setDropActive(false),
    onDrop: (detail) => {
      setDropActive(false);
      onDropAccount(String(detail.data.payload));
    },
  });

  return (
    <li
      ref={rowRef}
      data-testid="mfa-account-row"
      data-account-id={account.id}
      data-issuer={account.issuer}
      data-account={account.accountName}
      data-kind={account.kind}
      data-pinned={account.pinned ? "true" : "false"}
      data-copied={copied ? "true" : undefined}
      onContextMenu={onMenu}
      className="flex items-center gap-2 px-3 py-2 border-b transition-colors"
      style={{
        borderColor: "var(--taomni-divider)",
        background: copied || dropActive ? "var(--taomni-selected)" : undefined,
        outline: dropActive ? "1px dashed var(--taomni-accent)" : undefined,
      }}
    >
      {reorderable ? (
        <span
          data-testid="mfa-account-drag"
          role="button"
          aria-label={t("mfa.dragHandle", { name })}
          title={t("mfa.dragHandle", { name })}
          className="shrink-0 cursor-grab text-[var(--taomni-text-muted)] touch-none"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            // Like TabBar: no focus change, text selection or native drag on
            // mousedown, any of which would cancel the custom drag.
            event.preventDefault();
            startCustomDrag({
              event,
              data: { mime: MFA_DRAG_MIME, payload: account.id },
              ghostText: name,
            });
          }}
        >
          <GripVertical className="w-3.5 h-3.5" />
        </span>
      ) : null}
      <button
        type="button"
        data-testid="mfa-account-pin"
        aria-pressed={account.pinned}
        aria-label={account.pinned ? t("mfa.unpin") : t("mfa.pin")}
        title={account.pinned ? t("mfa.unpin") : t("mfa.pin")}
        className="shrink-0 rounded p-0.5 hover:bg-[var(--taomni-hover)]"
        onClick={onTogglePin}
      >
        <Star
          className="w-3.5 h-3.5"
          fill={account.pinned ? "currentColor" : "none"}
          style={{ color: account.pinned ? "#e0a800" : "var(--taomni-text-muted)" }}
        />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span data-testid="mfa-account-issuer" className="truncate text-[13px] font-semibold">
            {account.issuer || account.accountName}
          </span>
          {account.group ? (
            <span data-testid="mfa-account-group" className="taomni-pill shrink-0 text-[10px]" style={{ color: "var(--taomni-text-muted)" }}>
              {account.group}
            </span>
          ) : null}
          {account.kind === "hotp" ? (
            <span className="shrink-0 text-[10px]" style={{ color: "var(--taomni-text-muted)" }}>HOTP</span>
          ) : null}
        </div>
        <div data-testid="mfa-account-name" className="truncate text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
          {account.issuer ? account.accountName : ""}
        </div>
      </div>
      <button
        type="button"
        data-testid="mfa-account-code"
        data-code={code?.code ?? ""}
        aria-label={t("mfa.copyCode", { name })}
        title={t("mfa.copyCode", { name })}
        disabled={!code}
        className="shrink-0 rounded px-2 py-0.5 font-mono text-[20px] font-semibold tabular-nums tracking-wide hover:bg-[var(--taomni-hover)] focus-visible:outline focus-visible:outline-2 disabled:opacity-40"
        style={{ color: "var(--taomni-accent)" }}
        onClick={() => onCopy("current")}
        onKeyDown={onCodeKeyDown}
      >
        {code ? formatCode(code.code) : "••• •••"}
      </button>
      {showNext && code?.nextCode ? (
        <button
          type="button"
          data-testid="mfa-account-next-code"
          aria-label={t("mfa.copyNextCode", { name })}
          title={t("mfa.copyNextCode", { name })}
          className="shrink-0 rounded px-1 text-[11px] font-mono tabular-nums hover:bg-[var(--taomni-hover)]"
          style={{ color: "var(--taomni-text-muted)" }}
          onClick={() => onCopy("next")}
        >
          {t("mfa.nextCode", { code: formatCode(code.nextCode) })}
        </button>
      ) : null}
      {account.kind === "totp" ? (
        <MfaCountdown remaining={remaining} period={account.period} />
      ) : (
        <button
          type="button"
          data-testid="mfa-account-hotp-next"
          aria-label={t("mfa.hotpNextLabel", { name })}
          title={t("mfa.hotpNextLabel", { name })}
          className="shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-[var(--taomni-hover)]"
          onClick={onHotpNext}
        >
          <RotateCw className="w-3 h-3" />
          {t("mfa.hotpNext")}
        </button>
      )}
      <button
        type="button"
        data-testid="mfa-account-copy"
        aria-label={t("mfa.copyCode", { name })}
        title={t("mfa.copy")}
        disabled={!code}
        className="shrink-0 rounded p-1 hover:bg-[var(--taomni-hover)] disabled:opacity-40"
        onClick={() => onCopy("current")}
      >
        <Copy className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        data-testid="mfa-account-menu"
        aria-label={t("mfa.more", { name })}
        title={t("mfa.more", { name })}
        className="shrink-0 rounded p-1 hover:bg-[var(--taomni-hover)]"
        onClick={onMenu}
      >
        <MoreHorizontal className="w-3.5 h-3.5" />
      </button>
    </li>
  );
}
