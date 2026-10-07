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

const AVATAR_PALETTES = [
  { bg: "rgba(59, 130, 246, 0.12)", text: "#2563eb", border: "rgba(59, 130, 246, 0.25)" }, // Blue
  { bg: "rgba(16, 185, 129, 0.12)", text: "#059669", border: "rgba(16, 185, 129, 0.25)" }, // Emerald
  { bg: "rgba(139, 92, 246, 0.12)", text: "#7c3aed", border: "rgba(139, 92, 246, 0.25)" }, // Violet
  { bg: "rgba(245, 158, 11, 0.12)", text: "#d97706", border: "rgba(245, 158, 11, 0.25)" }, // Amber
  { bg: "rgba(236, 72, 153, 0.12)", text: "#db2777", border: "rgba(236, 72, 153, 0.25)" }, // Pink
  { bg: "rgba(14, 165, 233, 0.12)", text: "#0284c7", border: "rgba(14, 165, 233, 0.25)" }, // Sky
  { bg: "rgba(20, 184, 166, 0.12)", text: "#0d9488", border: "rgba(20, 184, 166, 0.25)" }, // Teal
  { bg: "rgba(249, 115, 22, 0.12)", text: "#ea580c", border: "rgba(249, 115, 22, 0.25)" }, // Orange
];

function getAvatarInfo(label: string) {
  const clean = label.trim();
  let hash = 0;
  for (let i = 0; i < clean.length; i++) {
    hash = (hash << 5) - hash + clean.charCodeAt(i);
    hash |= 0;
  }
  const palette = AVATAR_PALETTES[Math.abs(hash) % AVATAR_PALETTES.length];

  const words = clean.split(/[\s\-_.:/]+/).filter(Boolean);
  let initials = "";
  if (words.length >= 2) {
    initials = (words[0][0] + words[1][0]).toUpperCase();
  } else if (clean.length > 0) {
    const caps = clean.match(/[A-Z]/g);
    if (caps && caps.length >= 2) {
      initials = caps.slice(0, 2).join("");
    } else {
      initials = clean.slice(0, 2).toUpperCase();
    }
  } else {
    initials = "?";
  }
  return { initials, palette };
}

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
  const remaining = remainingSeconds(code?.validUntilMs ?? null, now, code?.validFromMs ?? null);
  const showNext = account.kind === "totp" && !!code?.nextCode && remaining <= MFA_NEXT_CODE_SECONDS;
  const avatar = getAvatarInfo(account.issuer || account.accountName);

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
      className="group relative flex items-center justify-between gap-3 px-3.5 py-3 mx-3 my-1.5 rounded-lg border transition-all duration-150"
      style={{
        borderColor: copied
          ? "var(--taomni-accent)"
          : dropActive
          ? "var(--taomni-accent)"
          : "var(--taomni-card-border)",
        background: copied
          ? "var(--taomni-selected)"
          : dropActive
          ? "var(--taomni-selected)"
          : "var(--taomni-card-bg)",
        boxShadow: "0 1px 2px 0 rgba(0, 0, 0, 0.03)",
        outline: dropActive ? "1px dashed var(--taomni-accent)" : undefined,
      }}
    >
      <div className="flex items-center gap-2.5 min-w-0 flex-1">
        {reorderable ? (
          <span
            data-testid="mfa-account-drag"
            role="button"
            aria-label={t("mfa.dragHandle", { name })}
            title={t("mfa.dragHandle", { name })}
            className="shrink-0 cursor-grab text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)] touch-none p-0.5 rounded"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
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
          className="shrink-0 rounded p-1 hover:bg-[var(--taomni-hover)] transition-colors"
          onClick={onTogglePin}
        >
          <Star
            className="w-3.5 h-3.5"
            fill={account.pinned ? "currentColor" : "none"}
            style={{ color: account.pinned ? "#e0a800" : "var(--taomni-text-muted)" }}
          />
        </button>
        <div
          data-testid="mfa-account-avatar"
          className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center font-bold text-[12px] tracking-wider select-none border"
          style={{
            backgroundColor: avatar.palette.bg,
            color: avatar.palette.text,
            borderColor: avatar.palette.border,
          }}
        >
          {avatar.initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span data-testid="mfa-account-issuer" className="truncate text-[14px] font-semibold tracking-tight">
              {account.issuer || account.accountName}
            </span>
            {account.group ? (
              <span data-testid="mfa-account-group" className="taomni-pill shrink-0 text-[10px]" style={{ color: "var(--taomni-text-muted)" }}>
                {account.group}
              </span>
            ) : null}
            {account.kind === "hotp" ? (
              <span className="shrink-0 px-1.5 py-0.2 rounded text-[10px] font-medium border" style={{ borderColor: "var(--taomni-divider)", color: "var(--taomni-text-muted)" }}>HOTP</span>
            ) : null}
          </div>
          <div data-testid="mfa-account-name" className="truncate text-[12px] mt-0.5" style={{ color: "var(--taomni-text-muted)" }}>
            {account.issuer ? account.accountName : ""}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <div className="flex flex-col items-end">
          <button
            type="button"
            data-testid="mfa-account-code"
            data-code={code?.code ?? ""}
            aria-label={t("mfa.copyCode", { name })}
            title={t("mfa.copyCode", { name })}
            disabled={!code}
            className="group/code relative rounded-md px-2 py-0.5 font-mono text-[22px] sm:text-[24px] font-bold tabular-nums tracking-widest hover:bg-[var(--taomni-hover)] focus-visible:outline focus-visible:outline-2 disabled:opacity-40 transition-colors"
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
              className="rounded px-1.5 py-0.2 text-[11px] font-mono tabular-nums hover:bg-[var(--taomni-hover)] transition-colors"
              style={{ color: "var(--taomni-text-muted)" }}
              onClick={() => onCopy("next")}
            >
              {t("mfa.nextCode", { code: formatCode(code.nextCode) })}
            </button>
          ) : null}
        </div>

        <div className="shrink-0 flex items-center">
          {account.kind === "totp" ? (
            <MfaCountdown remaining={remaining} period={account.period} />
          ) : (
            <button
              type="button"
              data-testid="mfa-account-hotp-next"
              aria-label={t("mfa.hotpNextLabel", { name })}
              title={t("mfa.hotpNextLabel", { name })}
              className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium hover:bg-[var(--taomni-hover)] transition-colors"
              style={{ borderColor: "var(--taomni-input-border)" }}
              onClick={onHotpNext}
            >
              <RotateCw className="w-3 h-3" />
              {t("mfa.hotpNext")}
            </button>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0 border-l pl-2" style={{ borderColor: "var(--taomni-divider)" }}>
          <button
            type="button"
            data-testid="mfa-account-copy"
            aria-label={t("mfa.copyCode", { name })}
            title={t("mfa.copy")}
            disabled={!code}
            className="rounded-md p-1.5 text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)] disabled:opacity-40 transition-colors"
            onClick={() => onCopy("current")}
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            data-testid="mfa-account-menu"
            aria-label={t("mfa.more", { name })}
            title={t("mfa.more", { name })}
            className="rounded-md p-1.5 text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)] transition-colors"
            onClick={onMenu}
          >
            <MoreHorizontal className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </li>
  );
}
