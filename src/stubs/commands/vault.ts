

export const VAULT_STORAGE_KEY = "taomni.stub.vault.v1";

export interface StubVaultEntry {
  id: string;
  kind: string;
  label: string;
  plaintext: string;
  created_at: number;
  updated_at: number;
}

export interface StubVaultState {
  state: "empty" | "locked" | "unlocked";
  masterPassword?: string;
  entries: StubVaultEntry[];
}

export function loadStubVault(): StubVaultState {
  try {
    const raw = localStorage.getItem(VAULT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.entries)) {
        return parsed;
      }
    }
  } catch {}
  return { state: "empty", entries: [] };
}

export function saveStubVault(v: StubVaultState): void {
  try {
    localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(v));
  } catch {}
}

export async function invokeVault<T>(cmd: string, args?: any): Promise<T> {
  switch (cmd) {

    case "vault_status": {
      const v = loadStubVault();
      return ({
        state: v.state,
        entry_count: v.entries.length,
      } as unknown) as T;
    }

    case "vault_init": {
      const v = loadStubVault();
      const pw = (args?.masterPassword as string) ?? "";
      v.masterPassword = pw;
      v.state = "unlocked";
      saveStubVault(v);
      return undefined as T;
    }

    case "vault_unlock": {
      const v = loadStubVault();
      const pw = (args?.masterPassword as string) ?? "";
      if (v.masterPassword && pw !== v.masterPassword) {
        throw new Error("Incorrect master password");
      }
      v.state = "unlocked";
      saveStubVault(v);
      return undefined as T;
    }

    case "vault_lock": {
      const v = loadStubVault();
      if (v.state === "unlocked") {
        v.state = "locked";
        saveStubVault(v);
      }
      return undefined as T;
    }

    case "vault_change_master": {
      const v = loadStubVault();
      const oldPw = (args?.oldPassword as string) ?? "";
      const newPw = (args?.newPassword as string) ?? "";
      if (v.masterPassword && oldPw !== v.masterPassword) {
        throw new Error("Incorrect master password");
      }
      v.masterPassword = newPw;
      saveStubVault(v);
      return undefined as T;
    }

    case "vault_put": {
      const v = loadStubVault();
      if (v.state !== "unlocked") {
        throw new Error("VAULT_LOCKED");
      }
      const id = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const entry: StubVaultEntry = {
        id,
        kind: (args?.kind as string) ?? "secret",
        label: (args?.label as string) ?? "",
        plaintext: (args?.plaintext as string) ?? "",
        created_at: now,
        updated_at: now,
      };
      v.entries.push(entry);
      saveStubVault(v);
      return ({ id, reference: `vault:${id}` } as unknown) as T;
    }

    case "vault_update": {
      const v = loadStubVault();
      if (v.state !== "unlocked") {
        throw new Error("VAULT_LOCKED");
      }
      const id = args?.id as string;
      const entry = v.entries.find((e) => e.id === id);
      if (entry) {
        entry.plaintext = (args?.plaintext as string) ?? "";
        entry.updated_at = Math.floor(Date.now() / 1000);
        saveStubVault(v);
      }
      return undefined as T;
    }

    case "vault_delete": {
      const v = loadStubVault();
      if (v.state !== "unlocked") {
        throw new Error("VAULT_LOCKED");
      }
      const id = args?.id as string;
      v.entries = v.entries.filter((e) => e.id !== id);
      saveStubVault(v);
      return undefined as T;
    }

    case "vault_list": {
      const v = loadStubVault();
      if (v.state !== "unlocked") {
        throw new Error("VAULT_LOCKED");
      }
      return (v.entries.map(({ id, kind, label, created_at, updated_at }) => ({
        id,
        kind,
        label,
        created_at,
        updated_at,
      })) as unknown) as T;
    }
    default: throw new Error(`Unhandled vault stub command: ${cmd}`);
  }
}
