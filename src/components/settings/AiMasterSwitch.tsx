import { useAiStore } from "../../stores/aiStore";
import { Power } from "lucide-react";

/**
 * Top-level toggle that disables every AI surface (drawer button, voice
 * mic button, ?? interceptor, status segments). When on, the app behaves
 * exactly like a plain terminal — zero network calls, zero models loaded.
 *
 * This is the "panic" off-switch the security-conscious user wants. It is
 * separate from the [[full-local-mode]] toggle, which keeps AI on but
 * forces all calls to loopback.
 */
export function AiMasterSwitch() {
  const { config, saveConfig } = useAiStore();
  if (!config) return null;

  const disabled = !!config.fully_disabled;

  const toggle = async () => {
    await saveConfig({ ...config, fully_disabled: !disabled });
  };

  return (
    <div
      className={`flex items-center gap-3 rounded border p-3 cursor-pointer transition-colors ${
        disabled
          ? "border-yellow-500/50 bg-yellow-500/10"
          : "border-[var(--moba-divider)] bg-[var(--moba-bg)]"
      }`}
      onClick={toggle}
    >
      <Power
        className={`w-5 h-5 shrink-0 ${disabled ? "text-yellow-300" : "text-[var(--moba-text-muted)]"}`}
      />
      <div className="flex-1">
        <div className="text-[13px] font-semibold">
          完全禁用 AI {disabled ? "· 已开启" : ""}
        </div>
        <div className="text-[11px] text-[var(--moba-text-muted)]">
          {disabled
            ? "所有 AI 入口隐藏；无网络调用、无模型加载、零额外内存"
            : "保留 AI 功能。打开后恢复纯终端形态，作为离线/合规场景的总开关。"}
        </div>
      </div>
      <div
        className={`w-9 h-5 rounded-full transition-colors relative ${
          disabled ? "bg-yellow-500" : "bg-[var(--moba-divider)]"
        }`}
      >
        <div
          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
            disabled ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </div>
    </div>
  );
}
