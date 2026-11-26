import { useEffect } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { X } from "lucide-react";
import { AsrPanel } from "../settings/AsrPanel";
import { useAiStore } from "../../stores/aiStore";
import { useT } from "../../lib/i18n";
import { ModalSurface } from "../ui/ModalSurface";

export const useVoiceSettingsStore = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/** One host per window, independent of responsive/contextual dictation buttons. */
export function VoiceSettingsDialog() {
  const { open, setOpen } = useVoiceSettingsStore();
  const disabled = useAiStore((s) => !!s.config?.fully_disabled);
  const t = useT();
  useEffect(() => { if (disabled) setOpen(false); }, [disabled, setOpen]);
  if (!open || disabled) return null;
  return createPortal(
    <ModalSurface
      aria-label={t("voice.settings")}
      className="taomni-modal"
      data-bleed="true"
      data-size="complex"
      data-taomni-context-menu=""
      data-testid="voice-settings-dialog"
      initialFocus='[data-testid="voice-settings-close"]'
      onCancel={() => setOpen(false)}
    >
      <button
        type="button"
        className="absolute top-4 right-4 z-[var(--taomni-z-sticky)] bg-[var(--taomni-panel-bg)] taomni-btn h-[32px] w-[32px] p-0 flex items-center justify-center"
        data-testid="voice-settings-close"
        aria-label={t("voice.close")}
        onClick={() => setOpen(false)}
      >
        <X className="h-[16px] w-[16px] shrink-0" />
      </button>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <AsrPanel />
      </div>
    </ModalSurface>,
    document.body,
  );
}
