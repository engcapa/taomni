import { useEffect, useState } from "react";
import { Camera, Image as ImageIcon, KeyRound, ScanLine, X } from "lucide-react";
import { useT } from "../../lib/i18n";
import { MfaImportError, parseImportTexts, type MfaParsedItem } from "../../lib/mfa/otpauth";
import { MfaCameraPane } from "./MfaCameraPane";
import { MfaImagePane, type MfaTextsOutcome } from "./MfaImagePane";
import { MfaImportPreview } from "./MfaImportPreview";
import { MfaScreenPane } from "./MfaScreenPane";
import { MfaSecretForm } from "./MfaSecretForm";

export type MfaAddMode = "secret" | "image" | "screen" | "camera";
export const MFA_ADD_MODES: MfaAddMode[] = ["secret", "image", "screen", "camera"];

const MODE_ICONS: Record<MfaAddMode, typeof KeyRound> = {
  secret: KeyRound,
  image: ImageIcon,
  screen: ScanLine,
  camera: Camera,
};

const MODE_LABELS: Record<MfaAddMode, string> = {
  secret: "mfa.modeSecret",
  image: "mfa.modeImage",
  screen: "mfa.modeScreen",
  camera: "mfa.modeCamera",
};

export function MfaAddDialog({
  initialMode,
  initialItems,
  onClose,
  onAdded,
}: {
  initialMode: MfaAddMode;
  /** Accounts already decoded elsewhere (e.g. a paste on the MFA tab). */
  initialItems?: MfaParsedItem[] | null;
  onClose: () => void;
  onAdded: (count: number) => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<MfaAddMode>(initialMode);
  const [items, setItems] = useState<MfaParsedItem[] | null>(initialItems ?? null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** Turn decoded QR texts into a preview, or explain why nothing matched. */
  const handleTexts = (texts: string[]): MfaTextsOutcome => {
    try {
      const { items: parsed } = parseImportTexts(texts);
      if (parsed.length === 0) return { ok: false, message: t("mfa.imageNotOtp") };
      setItems(parsed);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: t("mfa.imageInvalid", { error: err instanceof MfaImportError ? err.message : String(err) }) };
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.4)" }} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("mfa.addTitle")}
        data-testid="mfa-add-dialog"
        data-mode={items ? "preview" : mode}
        className="w-[520px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] overflow-y-auto rounded shadow-lg"
        style={{ background: "var(--taomni-bg)", border: "1px solid var(--taomni-card-border)", color: "var(--taomni-text)" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-4 py-2" style={{ borderColor: "var(--taomni-divider)" }}>
          <div className="text-sm font-semibold">{items ? t("mfa.previewTitle") : t("mfa.addTitle")}</div>
          <button type="button" data-testid="mfa-add-close" aria-label={t("mfa.close")} className="rounded p-1 hover:bg-[var(--taomni-hover)]" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {!items ? (
          <div role="tablist" aria-label={t("mfa.addTitle")} className="flex gap-1 border-b px-3 pt-2" style={{ borderColor: "var(--taomni-divider)" }}>
            {MFA_ADD_MODES.map((entry) => {
              const Icon = MODE_ICONS[entry];
              return (
                <button
                  key={entry}
                  type="button"
                  role="tab"
                  aria-selected={mode === entry}
                  data-testid={`mfa-add-mode-${entry}`}
                  className="inline-flex items-center gap-1 rounded-t px-2.5 py-1.5 text-[12px] hover:bg-[var(--taomni-hover)]"
                  style={mode === entry ? { boxShadow: "inset 0 -2px 0 var(--taomni-accent)", fontWeight: 600 } : undefined}
                  onClick={() => setMode(entry)}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t(MODE_LABELS[entry])}
                </button>
              );
            })}
          </div>
        ) : null}
        <div className="p-4">
          {items ? (
            <MfaImportPreview items={items} onBack={() => setItems(null)} onImported={onAdded} />
          ) : mode === "secret" ? (
            <MfaSecretForm onAdded={onAdded} onCancel={onClose} onParsedItems={setItems} />
          ) : mode === "image" ? (
            <MfaImagePane onTexts={handleTexts} />
          ) : mode === "screen" ? (
            <MfaScreenPane onTexts={handleTexts} />
          ) : (
            <MfaCameraPane onTexts={handleTexts} />
          )}
        </div>
      </div>
    </div>
  );
}
