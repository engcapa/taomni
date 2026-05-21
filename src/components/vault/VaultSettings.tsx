import { useEffect, useState } from "react";
import { useVaultStore } from "../../stores/vaultStore";
import { VaultSetupDialog } from "./VaultSetupDialog";
import { VaultUnlockDialog } from "./VaultUnlockDialog";

type Action = null | "init" | "unlock" | "change-master";

export function VaultSettings() {
  const {
    state,
    entries,
    refresh,
    init,
    unlock,
    lock,
    changeMaster,
    reloadEntries,
    deleteEntry,
  } = useVaultStore();

  const [action, setAction] = useState<Action>(null);
  const [oldPw, setOldPw] = useState("");
  const [newPw1, setNewPw1] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    if (state === "unlocked") {
      void reloadEntries().catch(() => undefined);
    }
  }, [state, reloadEntries]);

  const handleChangeMaster = async () => {
    if (newPw1.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (newPw1 !== newPw2) {
      setError("New passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await changeMaster(oldPw, newPw1);
      setInfo("Master password updated.");
      setOldPw("");
      setNewPw1("");
      setNewPw2("");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        msg.includes("VAULT_BAD_PASSWORD") ? "Current master password is wrong." : msg,
      );
    } finally {
      setBusy(false);
    }
  };

  const stateBadge = (
    <span
      data-testid="vault-state-badge"
      className="px-2 py-0.5 text-[11px] rounded"
      style={{
        background:
          state === "unlocked"
            ? "var(--moba-accent)"
            : state === "locked"
              ? "var(--moba-hover)"
              : "transparent",
        color: state === "unlocked" ? "white" : "var(--moba-text-muted)",
        border:
          state === "empty" ? "1px dashed var(--moba-card-border)" : "1px solid transparent",
      }}
    >
      {state}
    </span>
  );

  return (
    <div className="p-4" data-testid="vault-settings">
      <div className="flex items-center gap-2 mb-3">
        <div className="text-sm font-semibold">Credential vault</div>
        {stateBadge}
      </div>

      <div className="text-[12px] mb-4" style={{ color: "var(--moba-text-muted)" }}>
        Saved passwords are encrypted with AES-256-GCM under a key derived from your master
        password (Argon2id). Lock the vault to evict the key from memory.
      </div>

      <div className="flex gap-2 mb-4">
        {state === "empty" && (
          <button
            type="button"
            data-testid="vault-init-button"
            className="px-3 py-1 text-[12px] rounded text-white"
            style={{ background: "var(--moba-accent)" }}
            onClick={() => setAction("init")}
          >
            Set master password
          </button>
        )}
        {state === "locked" && (
          <button
            type="button"
            data-testid="vault-unlock-button"
            className="px-3 py-1 text-[12px] rounded text-white"
            style={{ background: "var(--moba-accent)" }}
            onClick={() => setAction("unlock")}
          >
            Unlock
          </button>
        )}
        {state === "unlocked" && (
          <>
            <button
              type="button"
              data-testid="vault-lock-button"
              className="px-3 py-1 text-[12px] rounded hover:bg-[var(--moba-hover)]"
              onClick={() => void lock()}
            >
              Lock now
            </button>
            <button
              type="button"
              data-testid="vault-change-master-button"
              className="px-3 py-1 text-[12px] rounded hover:bg-[var(--moba-hover)]"
              onClick={() => {
                setAction("change-master");
                setError(null);
                setInfo(null);
              }}
            >
              Change master password
            </button>
          </>
        )}
      </div>

      {action === "change-master" && (
        <div
          className="mb-4 p-3 rounded"
          style={{ border: "1px solid var(--moba-card-border)" }}
          data-testid="vault-change-master-form"
        >
          <div className="text-[12px] font-semibold mb-2">Change master password</div>
          <input
            type="password"
            value={oldPw}
            onChange={(e) => setOldPw(e.target.value)}
            placeholder="Current password"
            className="moba-input w-full mb-2"
            autoComplete="current-password"
            data-testid="vault-change-master-old"
          />
          <input
            type="password"
            value={newPw1}
            onChange={(e) => setNewPw1(e.target.value)}
            placeholder="New password (min 8 chars)"
            className="moba-input w-full mb-2"
            autoComplete="new-password"
            data-testid="vault-change-master-new1"
          />
          <input
            type="password"
            value={newPw2}
            onChange={(e) => setNewPw2(e.target.value)}
            placeholder="Confirm new password"
            className="moba-input w-full mb-2"
            autoComplete="new-password"
            data-testid="vault-change-master-new2"
          />
          {error && (
            <div className="text-[12px] mb-2" style={{ color: "var(--moba-error, #c33)" }}>
              {error}
            </div>
          )}
          {info && (
            <div className="text-[12px] mb-2" style={{ color: "var(--moba-accent)" }}>
              {info}
            </div>
          )}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              className="px-3 py-1 text-[12px] rounded hover:bg-[var(--moba-hover)]"
              onClick={() => {
                setAction(null);
                setError(null);
                setInfo(null);
              }}
              disabled={busy}
            >
              Close
            </button>
            <button
              type="button"
              className="px-3 py-1 text-[12px] rounded text-white disabled:opacity-50"
              style={{ background: "var(--moba-accent)" }}
              onClick={() => void handleChangeMaster()}
              disabled={busy}
              data-testid="vault-change-master-submit"
            >
              {busy ? "Updating…" : "Update"}
            </button>
          </div>
        </div>
      )}

      {state === "unlocked" && (
        <div data-testid="vault-entries-section">
          <div className="text-[12px] font-semibold mb-2">
            Saved entries ({entries.length})
          </div>
          {entries.length === 0 ? (
            <div className="text-[12px]" style={{ color: "var(--moba-text-muted)" }}>
              No entries yet. Save a session or tunnel password to add one.
            </div>
          ) : (
            <div className="space-y-1">
              {entries.map((e) => (
                <div
                  key={e.id}
                  data-testid={`vault-entry-${e.id}`}
                  className="flex items-center gap-2 text-[12px] px-2 py-1 rounded"
                  style={{ border: "1px solid var(--moba-card-border)" }}
                >
                  <span className="flex-1">{e.label}</span>
                  <span style={{ color: "var(--moba-text-muted)" }}>{e.kind}</span>
                  <button
                    type="button"
                    className="px-2 py-0.5 rounded hover:bg-[var(--moba-hover)]"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete vault entry "${e.label}"? Sessions referencing it will fail to connect until updated.`,
                        )
                      ) {
                        void deleteEntry(e.id);
                      }
                    }}
                    data-testid={`vault-entry-delete-${e.id}`}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {action === "init" && (
        <VaultSetupDialog
          onCancel={() => setAction(null)}
          onSubmit={async (pw) => {
            await init(pw);
            setAction(null);
          }}
        />
      )}

      {action === "unlock" && (
        <VaultUnlockDialog
          onCancel={() => setAction(null)}
          onSubmit={async (pw) => {
            await unlock(pw);
            setAction(null);
          }}
        />
      )}
    </div>
  );
}
