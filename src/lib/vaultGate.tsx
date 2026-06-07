import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { VaultSetupDialog } from "../components/vault/VaultSetupDialog";
import { VaultUnlockDialog } from "../components/vault/VaultUnlockDialog";
import { useVaultStore } from "../stores/vaultStore";

/**
 * On-demand "vault gate". When the user opts to save a password but the vault
 * is not ready, this pops the right dialog *inline* — `VaultSetupDialog` if the
 * vault is empty (set a master password) or `VaultUnlockDialog` if it is locked
 * — and resolves once the vault is unlocked. This replaces the old flow where a
 * save would silently fail with a text hint telling the user to go fix the
 * vault under Settings.
 *
 * Usage (imperative, promise-based like `confirmAppDialog`):
 *
 *   if (!(await ensureVaultReady(reason))) return; // user cancelled
 *   await vaultPut(...);
 *
 * Mirrors the structure of `appDialogs.tsx`.
 */

interface PendingGate {
  id: number;
  reason?: string;
  resolve: (ready: boolean) => void;
}

let nextGateId = 1;
let gateHost: ((request: PendingGate) => void) | null = null;
const queuedBeforeHost: PendingGate[] = [];

/**
 * Ensure the credential vault is unlocked, prompting the user to set a master
 * password (empty vault) or unlock (locked vault) on demand. Resolves `true`
 * once the vault is unlocked, or `false` if the user cancels.
 *
 * @param reason Optional context line shown in the unlock dialog.
 */
export function ensureVaultReady(reason?: string): Promise<boolean> {
  // Fast path: already unlocked — no dialog needed. Read the freshest state we
  // have in the store; the provider re-checks against the backend anyway.
  if (useVaultStore.getState().state === "unlocked") {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const pending: PendingGate = { id: nextGateId++, reason, resolve };
    if (gateHost) {
      gateHost(pending);
    } else {
      queuedBeforeHost.push(pending);
    }
  });
}

const VaultGateContext = createContext<(reason?: string) => Promise<boolean>>(
  ensureVaultReady,
);

export function useVaultGate(): (reason?: string) => Promise<boolean> {
  return useContext(VaultGateContext);
}

export function VaultGateProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<PendingGate[]>([]);
  const refresh = useVaultStore((s) => s.refresh);
  const init = useVaultStore((s) => s.init);
  const unlock = useVaultStore((s) => s.unlock);
  const state = useVaultStore((s) => s.state);

  const enqueue = useCallback((request: PendingGate) => {
    setQueue((current) => current.concat(request));
  }, []);

  useEffect(() => {
    gateHost = enqueue;
    if (queuedBeforeHost.length > 0) {
      const queued = queuedBeforeHost.splice(0);
      setQueue((current) => current.concat(queued));
    }
    return () => {
      if (gateHost === enqueue) {
        gateHost = null;
      }
    };
  }, [enqueue]);

  const active = queue[0] ?? null;

  // When a gate opens, re-check the live vault status. The store state can be
  // stale (e.g. an auto-lock happened in the backend). If it turns out the
  // vault is already unlocked, resolve immediately without showing a dialog.
  useEffect(() => {
    if (!active) return;
    void refresh()
      .then(() => {
        if (useVaultStore.getState().state === "unlocked") {
          active.resolve(true);
          setQueue((current) => current.filter((entry) => entry.id !== active.id));
        }
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  const settle = useCallback((gate: PendingGate, ready: boolean) => {
    gate.resolve(ready);
    setQueue((current) => current.filter((entry) => entry.id !== gate.id));
  }, []);

  const api = useMemo(() => ensureVaultReady, []);

  return (
    <VaultGateContext.Provider value={api}>
      {children}
      {active && (
        // Wrapper creates a stacking context above editor modals (z-50), so
        // the gate dialog paints on top of an open SessionEditor / TunnelEditor.
        <div style={{ position: "relative", zIndex: 60 }}>
          {state === "empty" ? (
            <VaultSetupDialog
              onCancel={() => settle(active, false)}
              onSubmit={async (pw) => {
                await init(pw);
                settle(active, true);
              }}
            />
          ) : (
            <VaultUnlockDialog
              reason={active.reason}
              onCancel={() => settle(active, false)}
              onSubmit={async (pw) => {
                await unlock(pw);
                settle(active, true);
              }}
            />
          )}
        </div>
      )}
    </VaultGateContext.Provider>
  );
}
