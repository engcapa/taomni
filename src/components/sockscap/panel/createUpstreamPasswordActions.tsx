import { type SocksCapConfig } from "../../../lib/sockscap";
import { vaultPut, vaultStatus, VAULT_LOCKED_EVENT } from "../../../lib/ipc";


export interface CreateUpstreamPasswordActionsContext {
  cfg: SocksCapConfig | null;
  password: string;
  setStoringPass: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  t: import("../../../lib/i18n").TranslateFn;
  report: (text: string, ok?: boolean) => void;
  patchSelectedProfile: (partial: Partial<import("../../../lib/sockscap").SocksCapProfile>) => Promise<SocksCapConfig | null>;
  selectedProf: import("../../../lib/sockscap").SocksCapProfile;
  setPassword: import("react").Dispatch<import("react").SetStateAction<string>>;
}

export function createUpstreamPasswordActions(context: CreateUpstreamPasswordActionsContext) {
  const { cfg, password, setStoringPass, t, report, patchSelectedProfile, selectedProf, setPassword } = context;

  const storePassword = async () => {
    if (!cfg || !password) return;
    setStoringPass(true);
    try {
      const status = await vaultStatus().catch(() => null);
      if (!status || status.state !== "unlocked") {
        window.dispatchEvent(
          new CustomEvent(VAULT_LOCKED_EVENT, {
            detail: { reason: t("sockscap.vaultLocked") },
          }),
        );
        report(t("sockscap.vaultLocked"), false);
        return;
      }
      const res = await vaultPut(
        "sockscap_upstream_password",
        "SocksCap Upstream Password",
        password,
      );
      await patchSelectedProfile({
        upstream: { ...selectedProf.upstream, passwordRef: res.reference },
      });
      setPassword("");
      report(t("sockscap.passwordSaved"));
    } catch (e) {
      report(String(e), false);
    } finally {
      setStoringPass(false);
    }
  };

  const clearPassword = async () => {
    if (!cfg) return;
    setPassword("");
    await patchSelectedProfile({ upstream: { ...selectedProf.upstream, passwordRef: "" } });
    report(t("sockscap.passwordCleared"));
  };
  return { storePassword, clearPassword };
}
