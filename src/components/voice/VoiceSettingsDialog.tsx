import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { X } from "lucide-react";
import { AsrPanel } from "../settings/AsrPanel";
import { useAiStore } from "../../stores/aiStore";
import { useT } from "../../lib/i18n";

export const useVoiceSettingsStore = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/** One host per window, independent of responsive/contextual dictation buttons. */
export function VoiceSettingsDialog() {
  const { open, setOpen } = useVoiceSettingsStore();
  const disabled = useAiStore((s) => !!s.config?.fully_disabled);
  const closeRef = useRef<HTMLButtonElement>(null);
  const t = useT();
  useEffect(() => { if (disabled) setOpen(false); }, [disabled, setOpen]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); }
    };
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("keydown", escape, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [open, setOpen]);
  if (!open || disabled) return null;
  return createPortal(<div data-taomni-context-menu="" role="dialog" aria-modal="true" aria-label={t("voice.settings")} className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40" onClick={(e) => e.stopPropagation()}>
    <div className="relative max-h-[90vh] w-[960px] max-w-[95vw] overflow-hidden rounded-xl border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] shadow-2xl" data-testid="voice-settings-dialog">
      <button ref={closeRef} type="button" className="absolute top-4 right-4 z-10 bg-[var(--taomni-panel-bg)] taomni-btn h-[32px] w-[32px] p-0 flex items-center justify-center" data-testid="voice-settings-close" aria-label={t("voice.close")} onClick={() => setOpen(false)}><X className="h-[16px] w-[16px] shrink-0" /></button>
      <div className="max-h-[90vh] overflow-y-auto p-5"><AsrPanel /></div>
    </div>
  </div>, document.body);
}
