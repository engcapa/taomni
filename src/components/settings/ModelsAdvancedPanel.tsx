import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Cpu, Download, Loader2, Trash2, Globe2 } from "lucide-react";
import { useT } from "../../lib/i18n";

interface CudaPackStatus {
  installed: boolean;
  path: string;
  size_mb: number;
}

interface MirrorConfig {
  preference: string;
  custom_base: string | null;
}

/**
 * Mirror selection (§11.4) + on-demand CUDA pack (§11.6).
 *
 * Both knobs default to safe choices:
 * - Mirror = "auto" → probe-order resolution, no override
 * - CUDA pack = uninstalled → CPU/Vulkan/Metal until the user opts in
 *
 * The CUDA pack section is only shown when not on macOS (Metal is built-in)
 * and not in full-local mode (downloads still need network).
 */
export function ModelsAdvancedPanel() {
  const t = useT();
  const [mirror, setMirror] = useState<MirrorConfig>({ preference: "auto", custom_base: null });
  const [pack, setPack] = useState<CudaPackStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const isMac = typeof navigator !== "undefined" && /macintosh/i.test(navigator.userAgent);

  const PREF_OPTIONS = [
    { value: "auto",        label: t("aiSettings.modelsPrefAuto"),        desc: t("aiSettings.modelsPrefAutoDesc") },
    { value: "modelscope",  label: t("aiSettings.modelsPrefModelScope"), desc: t("aiSettings.modelsPrefModelScopeDesc") },
    { value: "github",      label: t("aiSettings.modelsPrefGithub"),     desc: t("aiSettings.modelsPrefGithubDesc") },
    { value: "gh_proxy",    label: t("aiSettings.modelsPrefGhProxy"),    desc: t("aiSettings.modelsPrefGhProxyDesc") },
    { value: "custom",      label: t("aiSettings.modelsPrefCustom"),     desc: t("aiSettings.modelsPrefCustomDesc") },
  ] as const;

  useEffect(() => {
    void invoke<MirrorConfig>("mirror_get_config").then(setMirror).catch(() => undefined);
    void invoke<CudaPackStatus>("cuda_pack_status").then(setPack).catch(() => undefined);
  }, []);

  const updateMirror = async (patch: Partial<MirrorConfig>) => {
    const next = { ...mirror, ...patch };
    setMirror(next);
    try {
      await invoke("mirror_set_config", { config: next });
    } catch (e) {
      setStatus(t("aiSettings.modelsMirrorSaveFailed", { error: String(e) }));
    }
  };

  const installCuda = async () => {
    setBusy("install");
    setStatus(null);
    try {
      const path = await invoke<string>("cuda_pack_install");
      setStatus(t("aiSettings.modelsCudaInstalledMsg", { path }));
      const fresh = await invoke<CudaPackStatus>("cuda_pack_status");
      setPack(fresh);
    } catch (e) {
      setStatus(t("aiSettings.modelsCudaDownloadFailed", { error: String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const uninstallCuda = async () => {
    setBusy("uninstall");
    setStatus(null);
    try {
      await invoke("cuda_pack_uninstall");
      const fresh = await invoke<CudaPackStatus>("cuda_pack_status");
      setPack(fresh);
      setStatus(t("aiSettings.modelsCudaRemovedMsg"));
    } catch (e) {
      setStatus(t("aiSettings.modelsCudaRemoveFailed", { error: String(e) }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Globe2 className="w-4 h-4 text-[var(--moba-accent)]" />
        <div className="text-[13px] font-semibold flex-1">{t("aiSettings.modelsTitle")}</div>
      </div>

      {/* Mirror preference */}
      <div>
        <div className="text-[11px] text-[var(--moba-text-muted)] mb-1.5">{t("aiSettings.modelsDownloadSource")}</div>
        <div className="space-y-1">
          {PREF_OPTIONS.map(({ value, label, desc }) => (
            <label key={value} className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="mirror-pref"
                value={value}
                checked={mirror.preference === value}
                onChange={() => updateMirror({ preference: value })}
                className="mt-0.5 accent-[var(--moba-accent)]"
              />
              <div>
                <div className="text-[12px]">{label}</div>
                <div className="text-[11px] text-[var(--moba-text-muted)]">{desc}</div>
              </div>
            </label>
          ))}
        </div>
        {mirror.preference === "custom" && (
          <input
            type="text"
            className="moba-input h-7 w-full text-[12px] mt-2"
            placeholder={t("aiSettings.modelsCustomPlaceholder")}
            value={mirror.custom_base ?? ""}
            onChange={(e) => updateMirror({ custom_base: e.target.value || null })}
          />
        )}
      </div>

      {/* CUDA pack */}
      {!isMac && (
        <div className="pt-3 border-t border-[var(--moba-divider)]">
          <div className="flex items-center gap-2 mb-1.5">
            <Cpu className="w-3.5 h-3.5 text-[var(--moba-accent)]" />
            <div className="text-[12px] font-semibold flex-1">{t("aiSettings.modelsCudaTitle")}</div>
            {pack && (
              <span className={`text-[10px] ${pack.installed ? "text-green-400" : "text-[var(--moba-text-muted)]"}`}>
                {pack.installed ? t("aiSettings.modelsCudaInstalled", { size: pack.size_mb }) : t("aiSettings.modelsCudaNotInstalled")}
              </span>
            )}
          </div>
          <p className="text-[11px] text-[var(--moba-text-muted)] leading-snug mb-2">
            {t("aiSettings.modelsCudaDesc")}
          </p>
          <div className="flex gap-2">
            {pack?.installed ? (
              <button
                type="button"
                className="moba-btn h-7 px-2 text-[11px] inline-flex items-center gap-1.5"
                onClick={uninstallCuda}
                disabled={!!busy}
              >
                {busy === "uninstall" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                {t("aiSettings.modelsCudaRemove")}
              </button>
            ) : (
              <button
                type="button"
                className="moba-btn h-7 px-2 text-[11px] inline-flex items-center gap-1.5"
                onClick={installCuda}
                disabled={!!busy}
              >
                {busy === "install" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                {t("aiSettings.modelsCudaDownload")}
              </button>
            )}
          </div>
        </div>
      )}

      {status && (
        <div className="text-[11px] text-[var(--moba-accent)] rounded border border-[var(--moba-divider)] bg-[var(--moba-bg)] px-2 py-1.5">
          {status}
        </div>
      )}
    </div>
  );
}
