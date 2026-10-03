import { useT } from "../../lib/i18n";

/** Seconds at or below which the countdown turns to the warning colour. */
export const MFA_WARNING_SECONDS = 5;

/** Circular TOTP countdown with the remaining seconds in the middle. */
export function MfaCountdown({ remaining, period }: { remaining: number; period: number }) {
  const t = useT();
  const radius = 9;
  const circumference = 2 * Math.PI * radius;
  const fraction = period > 0 ? Math.min(1, Math.max(0, remaining / period)) : 0;
  const warning = remaining <= MFA_WARNING_SECONDS;
  const color = warning ? "var(--taomni-error, #d14343)" : "var(--taomni-accent)";
  return (
    <span
      data-testid="mfa-account-countdown"
      data-remaining={remaining}
      data-warning={warning || undefined}
      role="timer"
      aria-label={t("mfa.remaining", { seconds: remaining })}
      title={t("mfa.remaining", { seconds: remaining })}
      className="relative inline-flex h-7 w-7 shrink-0 items-center justify-center"
    >
      <svg viewBox="0 0 24 24" className="absolute inset-0 h-7 w-7 -rotate-90" aria-hidden="true">
        <circle cx="12" cy="12" r={radius} fill="none" stroke="var(--taomni-divider)" strokeWidth="2.5" />
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
        />
      </svg>
      <span aria-hidden="true" className="relative text-[10px] font-semibold tabular-nums" style={{ color: warning ? color : "var(--taomni-text-muted)" }}>
        {remaining}
      </span>
    </span>
  );
}
