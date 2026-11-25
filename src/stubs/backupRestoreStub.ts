// Renderer-only archive metadata and staging. No disk restore or cryptography.
import type { BackupManifest, BackupRange } from "../lib/backup";
import { loadStubVault } from "./commands/vault";

const archivesKey = "taomni.stub.backup.archives.v1";
const stagedKey = "taomni.stub.backup.staged.v1";
type Archives = Record<string, { manifest: BackupManifest; encrypted: boolean }>;

function archives(): Archives {
  return JSON.parse(localStorage.getItem(archivesKey) ?? "{}");
}

export function rememberBackupPreview(path: string, range: BackupRange, encrypted: boolean): void {
  const options = range.customOptions;
  const mfa = JSON.parse(localStorage.getItem("taomni.stub.mfa.v1") ?? "null");
  const includeMfa = (range.scope !== "custom" || options?.includeMfa === true) && !!mfa?.accounts?.length;
  const includeVault = includeMfa || range.scope !== "custom" || options?.includeVault === true;
  const names = [includeVault && "databases/vault.db", includeMfa && "databases/mfa.db"].filter((name): name is string => !!name);
  const manifest: BackupManifest = {
    formatVersion: 1, appName: "Taomni", appVersion: "browser-preview", createdAt: Date.now(),
    backupScope: range.scope, encrypted,
    files: names.map((name) => ({ path: name, sizeBytes: 0, sha256: "0".repeat(64) })),
  };
  localStorage.setItem(archivesKey, JSON.stringify({ ...archives(), [path]: { manifest, encrypted } }));
}

export function backupRestoreStub(command: string, args: Record<string, unknown>): unknown {
  const path = typeof args.path === "string" ? args.path : "";
  const archive = archives()[path];
  if (!archive) throw new Error("Preview archive is unavailable; create a local backup first");
  if (archive.encrypted) throw new Error("Encrypted archive verification requires native testing");
  if (command === "backup_inspect") return archive.manifest;
  if (command !== "backup_stage_restore") throw new Error("Unsupported preview restore operation");
  const vault = loadStubVault();
  if (vault.state !== "empty") {
    if (typeof args.vaultPassword !== "string" || !args.vaultPassword.trim()) throw new Error("VAULT_PASSWORD_REQUIRED");
    if (args.vaultPassword !== vault.masterPassword) throw new Error("VAULT_BAD_PASSWORD");
  }
  localStorage.setItem(stagedKey, JSON.stringify({ path, manifest: archive.manifest }));
  return { manifest: archive.manifest, restartRequired: true, message: "Preview restore staged; native apply is not simulated" };
}
