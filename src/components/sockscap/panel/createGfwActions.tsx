import { sockscapImportRules, sockscapRefreshGfwlist, sockscapStatus, type GfwListStatus, type SocksCapConfig, type SocksCapStatus } from "../../../lib/sockscap";
import { isTauriRuntime } from "../../../lib/runtime";
import { open } from "@tauri-apps/plugin-dialog";


export interface CreateGfwActionsContext {
  cfg: SocksCapConfig | null;
  locked: boolean;
  setBusy: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setGfw: import("react").Dispatch<import("react").SetStateAction<GfwListStatus | null>>;
  report: (text: string, ok?: boolean) => void;
  t: import("../../../lib/i18n").TranslateFn;
  setStatus: import("react").Dispatch<import("react").SetStateAction<SocksCapStatus | null>>;
}

export function createGfwActions(context: CreateGfwActionsContext) {
  const { cfg, locked, setBusy, setGfw, report, t, setStatus } = context;

  const onRefreshGfw = async () => {
    if (!cfg || locked) return;
    setBusy(true);
    try {
      const res = await sockscapRefreshGfwlist(cfg.gfwlist.url);
      setGfw(res);
      if (res.error) report(res.error, false);
      else report(t("sockscap.gfwRefreshed", { count: String(res.ruleCount) }));
      const st = await sockscapStatus().catch(() => null);
      setStatus(st);
    } catch (e) {
      report(String(e), false);
    } finally {
      setBusy(false);
    }
  };

  const onImportGfw = async () => {
    if (locked) return;
    try {
      if (!isTauriRuntime()) {
        report(t("sockscap.importDesktopOnly"), false);
        return;
      }
      const selected = await open({
        multiple: false,
        filters: [{ name: "GFWList / AutoProxy", extensions: ["txt", "conf", "list"] }],
      });
      if (!selected || Array.isArray(selected)) return;
      setBusy(true);
      const res = await sockscapImportRules(selected);
      setGfw(res);
      report(t("sockscap.gfwImported", { count: String(res.ruleCount) }));
    } catch (e) {
      report(String(e), false);
    } finally {
      setBusy(false);
    }
  };
  return { onRefreshGfw, onImportGfw };
}
