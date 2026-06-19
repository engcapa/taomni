import { useEffect, useState } from "react";
import { Lock } from "lucide-react";

import { useVaultStore } from "../../stores/vaultStore";
import { VaultSetupDialog } from "./VaultSetupDialog";
import { VaultUnlockDialog } from "./VaultUnlockDialog";

/**
 * Gate that renders `children` only when the app's master-password vault is
 * unlocked. While locked it shows the existing unlock dialog; for a vault that
 * was never set up it shows the setup dialog (the feature requires a master
 * password). Cancelling either dialog drops to a dismissable placeholder with
 * a button to retry, so the user is never trapped in a modal.
 *
 * The vault root key lives in the backend (single AppState), so unlocking in
 * one window unlocks every window — this gate just reflects that shared state.
 */
export function VaultGate({
  children,
  reason,
  lockedTitle = "已锁定",
  lockedHint = "需要主密码解锁。",
}: {
  children: React.ReactNode;
  /** Context line shown in the unlock dialog explaining why we prompt. */
  reason?: string;
  lockedTitle?: string;
  lockedHint?: string;
}) {
  const state = useVaultStore((s) => s.state);
  const refresh = useVaultStore((s) => s.refresh);
  const unlock = useVaultStore((s) => s.unlock);
  const init = useVaultStore((s) => s.init);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (state === "unlocked") return <>{children}</>;

  const placeholder = (
    <Placeholder
      title={lockedTitle}
      hint={lockedHint}
      actionLabel={
        dismissed ? (state === "empty" ? "设置主密码" : "解锁") : undefined
      }
      onAction={dismissed ? () => setDismissed(false) : undefined}
    />
  );

  if (dismissed) return placeholder;

  if (state === "empty") {
    return (
      <>
        {placeholder}
        <VaultSetupDialog
          onCancel={() => setDismissed(true)}
          onSubmit={async (pw) => {
            await init(pw);
          }}
        />
      </>
    );
  }

  // locked
  return (
    <>
      {placeholder}
      <VaultUnlockDialog
        reason={reason}
        onCancel={() => setDismissed(true)}
        onSubmit={async (pw) => {
          await unlock(pw);
        }}
      />
    </>
  );
}

function Placeholder({
  title,
  hint,
  actionLabel,
  onAction,
}: {
  title: string;
  hint: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div
      className="grid h-full w-full place-items-center"
      style={{ background: "var(--taomni-bg)", color: "var(--taomni-text-muted)" }}
    >
      <div className="flex flex-col items-center gap-3 px-6 text-center">
        <Lock className="h-8 w-8" style={{ color: "var(--taomni-text-muted)" }} />
        <div className="text-[14px] font-semibold" style={{ color: "var(--taomni-text)" }}>
          {title}
        </div>
        <div className="max-w-[280px] text-[12px]">{hint}</div>
        {actionLabel && onAction ? (
          <button
            type="button"
            onClick={onAction}
            className="rounded-lg px-4 py-2 text-[12px] font-semibold text-white"
            style={{ background: "var(--taomni-accent)" }}
          >
            {actionLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}
