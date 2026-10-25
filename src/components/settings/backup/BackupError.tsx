import type { TranslateFn } from "../../../lib/i18n";
export function BackupError({ error, t }: { error: string; t: TranslateFn }) {
  let key = "failed";
  if (error.includes("BACKUP_CONFIG_CONFLICT")) key = "conflict";
  else if (error.includes("BACKUP_BROWSER_OPEN_FAILED")) key = "browser";
  else if (error.startsWith("BACKUP_AUTHORIZATION")) key = "authorization";
  else if (error.startsWith("BACKUP_PERMISSION")) key = "permissions";
  else if (error.startsWith("BACKUP_STORAGE")) key = "storage";
  else if (error.startsWith("BACKUP_OTHER_INSTANCE")) key = "otherInstance";
  else if (error.startsWith("BACKUP_TRANSIENT")) key = "network";
  else if (error.startsWith("BACKUP_REGISTRATION_RECOVERY")) key = "registration";
  else if (error.includes("BACKUP_CONFIG_NOT_LOADED")) key = "config";
  else if (/credential store|credentials in the system/i.test(error)) key = "credentialStore";
  else if (/CLI.*(configuration|application|file|credential)|existing CLI/i.test(error)) key = "cli";
  else if (/application credentials are invalid/i.test(error)) key = "appCredentials";
  else if (/authorization.*(expired|interrupted|uncertain)|token refresh.*(interrupted|uncertain)/i.test(error)) key = "authorization";
  else if (/permissions|scope|offline_access/i.test(error)) key = "permissions";
  else if (/declined/i.test(error)) key = "declined";
  else if (/connect Feishu/i.test(error)) key = "connect";
  else if (/password/i.test(error)) key = "password";
  else if (/proxy|network|Cannot connect to backup service/i.test(error)) key = "network";
  else if (/NATIVE_VERSION_UNSUPPORTED|native versioning is unavailable/i.test(error)) key = "version";
  else if (/registration may have completed|registration completed/i.test(error)) key = "registration";
  else if (/active.*tasks|Another Feishu connection|being authorized/i.test(error)) key = "busy";
  return <div role="alert" className="break-all text-xs text-red-500">
    <p>{t(`remoteBackup.errors.${key}`)}</p>
    {(!error.startsWith("BACKUP_") || error.includes(":")) && <details><summary>{t("remoteBackup.errorDetails")}</summary><p>{error}</p></details>}
  </div>;
}
