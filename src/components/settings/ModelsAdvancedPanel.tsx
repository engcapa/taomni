import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Cpu, Download, Loader2, Trash2, Globe2 } from "lucide-react";

interface CudaPackStatus {
  installed: boolean;
  path: string;
  size_mb: number;
}

interface MirrorConfig {
  preference: string;
  custom_base: string | null;
}

const PREF_OPTIONS = [
  { value: "auto",        label: "Automatic (recommended)", desc: "Probe-order: pick the fastest reachable mirror" },
  { value: "modelscope",  label: "ModelScope first",         desc: "Best for users in mainland China" },
  { value: "github",      label: "GitHub direct",            desc: "Recommended for users outside China" },
  { value: "gh_proxy",    label: "gh-proxy",                 desc: "GitHub via gh-proxy.com" },
  { value: "custom",      label: "Custom base URL",          desc: "Enterprise / self-hosted mirror" },
] as const;

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
  const [mirror, setMirror] = useState<MirrorConfig>({ preference: "auto", custom_base: null });
  const [pack, setPack] = useState<CudaPackStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const isMac = typeof navigator !== "undefined" && /macintosh/i.test(navigator.userAgent);

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
      setStatus(`Failed to save mirror config: ${String(e)}`);
    }
  };

  const installCuda = async () => {
    setBusy("install");
    setStatus(null);
    try {
      const path = await invoke<string>("cuda_pack_install");
      setStatus(`Installed to ${path}`);
      const fresh = await invoke<CudaPackStatus>("cuda_pack_status");
      setPack(fresh);
    } catch (e) {
      setStatus(`Download failed: ${String(e)}`);
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
      setStatus("CUDA pack removed.");
    } catch (e) {
      setStatus(`Removal failed: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Globe2 className="w-4 h-4 text-[var(--moba-accent)]" />
        <div className="text-[13px] font-semibold flex-1">Model distribution & GPU acceleration</div>
      </div>

      {/* Mirror preference */}
      <div>
        <div className="text-[11px] text-[var(--moba-text-muted)] mb-1.5">Download source</div>
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
            placeholder="https://my-mirror.example.com/newmob"
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
            <div className="text-[12px] font-semibold flex-1">NVIDIA CUDA acceleration pack (120 MB)</div>
            {pack && (
              <span className={`text-[10px] ${pack.installed ? "text-green-400" : "text-[var(--moba-text-muted)]"}`}>
                {pack.installed ? `${pack.size_mb} MB installed` : "Not installed"}
              </span>
            )}
          </div>
          <p className="text-[11px] text-[var(--moba-text-muted)] leading-snug mb-2">
            Optional; only needed for NVIDIA GPUs. Once installed, llama-server enables CUDA automatically; requires driver ≥ 535.
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
                Remove CUDA pack
              </button>
            ) : (
              <button
                type="button"
                className="moba-btn h-7 px-2 text-[11px] inline-flex items-center gap-1.5"
                onClick={installCuda}
                disabled={!!busy}
              >
                {busy === "install" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                Download NVIDIA pack
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
