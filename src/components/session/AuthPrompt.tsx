import { useEffect, useState } from "react";
import { KeyRound, X } from "lucide-react";
import { useVaultStore } from "../../stores/vaultStore";

interface AuthPromptProps {
  host: string;
  username: string;
  onSubmit: (password: string, saveToVault: boolean) => void;
  onCancel: () => void;
}

export function AuthPrompt({ host, username, onSubmit, onCancel }: AuthPromptProps) {
  const [password, setPassword] = useState("");
  const [save, setSave] = useState(false);
  const vaultState = useVaultStore((s) => s.state);
  const refreshVault = useVaultStore((s) => s.refresh);

  useEffect(() => {
    void refreshVault().catch(() => undefined);
  }, [refreshVault]);

  // If the vault was uninitialized when we mounted but the user set it up
  // mid-prompt (e.g. via another window), `save` stays disabled until they
  // toggle the checkbox; that's fine — keeping behavior minimal.

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    onSubmit(password, save);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(20,30,45,0.4)" }}>
      <form
        data-testid="auth-prompt"
        onSubmit={handleSubmit}
        className="w-[400px] rounded-md shadow-2xl border overflow-hidden"
        style={{ background: "var(--moba-panel-bg)", borderColor: "var(--moba-chrome-border)", color: "var(--moba-text)" }}
      >
        <div className="h-8 flex items-center px-3"
             style={{ background: "linear-gradient(to bottom, #5895c8, #2b5d8b)", color: "white" }}>
          <KeyRound className="w-3.5 h-3.5 mr-1.5" />
          <span className="text-[12px] font-semibold">Authentication required</span>
          <div className="flex-1" />
          <button data-testid="auth-close" type="button" onClick={onCancel} className="hover:bg-white/20 rounded p-0.5">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="p-4">
          <div className="text-[12px] mb-3 text-[var(--moba-text-muted)]">
            Enter password for <span className="font-semibold text-[var(--moba-text)]">{username}@{host}</span>
          </div>
          <input
            data-testid="auth-password"
            aria-label="SSH password"
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="moba-input w-full h-8 text-[13px]"
            placeholder="Password"
          />
          <label
            className="flex items-center gap-1.5 mt-3 text-[11px] cursor-pointer"
            title={
              vaultState === "empty"
                ? "Set a master password in the vault settings first."
                : "When checked, the password is encrypted with your master password and stored for next time."
            }
          >
            <input
              type="checkbox"
              data-testid="auth-save-to-vault"
              className="moba-checkbox"
              checked={save}
              onChange={(e) => setSave(e.target.checked)}
              disabled={vaultState === "empty"}
            />
            <span style={{ color: "var(--moba-text-muted)" }}>
              {vaultState === "empty"
                ? "Save in vault (set up a master password first)"
                : "Save password in vault for this session"}
            </span>
          </label>
        </div>

        <div className="h-12 flex items-center justify-end px-3 gap-2 border-t"
             style={{ background: "var(--moba-quick-bg)", borderColor: "var(--moba-divider)" }}>
          <button data-testid="auth-cancel" type="button" onClick={onCancel}
                  className="moba-btn">
            Cancel
          </button>
          <button type="submit"
                  data-testid="auth-submit"
                  className="moba-btn font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={!password}
                  data-primary="true">
            Connect
          </button>
        </div>
      </form>
    </div>
  );
}
