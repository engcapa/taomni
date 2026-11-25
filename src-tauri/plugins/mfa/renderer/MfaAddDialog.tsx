import { SectionTabs, sectionTab } from "../../../../src/components/ui/SectionTabs";
import { useEffect, useState } from "react";
import { Camera, Image as ImageIcon, KeyRound, ScanLine, X } from "lucide-react";
import { useT } from "../../../../src/lib/i18n";
import { MfaImportError, parseImportTexts, type MfaParsedItem } from "../../../../src/lib/mfa/otpauth";
import { MfaCameraPane } from "./MfaCameraPane";
import { MfaImagePane, type MfaTextsOutcome } from "./MfaImagePane";
import { MfaImportPreview } from "./MfaImportPreview";
import { MfaScreenPane, type MfaScreenDecoder } from "./MfaScreenPane";
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

type ImportPreview = {
  items: MfaParsedItem[];
  screenDecoder?: MfaScreenDecoder;
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
  const [preview, setPreview] = useState<ImportPreview | null>(
    initialItems ? { items: initialItems } : null,
  );

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
  const handleTexts = (texts: string[], decoder?: MfaScreenDecoder): MfaTextsOutcome => {
    try {
      const { items: parsed } = parseImportTexts(texts);
      if (parsed.length === 0) return { ok: false, message: t("mfa.imageNotOtp") };
      setPreview({ items: parsed, screenDecoder: decoder });
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
        data-mode={preview ? "preview" : mode}
        data-screen-decoder={preview?.screenDecoder}
        className="w-[520px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] overflow-y-auto rounded shadow-lg"
        style={{ background: "var(--taomni-bg)", border: "1px solid var(--taomni-card-border)", color: "var(--taomni-text)" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-4 py-2" style={{ borderColor: "var(--taomni-divider)" }}>
          <div className="text-sm font-semibold">{preview ? t("mfa.previewTitle") : t("mfa.addTitle")}</div>
          <button type="button" data-testid="mfa-add-close" aria-label={t("mfa.close")} className="rounded p-1 hover:bg-[var(--taomni-hover)]" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {!preview ? (
          <SectionTabs aria-label={t("mfa.addTitle")} className="flex gap-1 border-b px-3 pt-2" style={{ borderColor: "var(--taomni-divider)" }}>
            {MFA_ADD_MODES.map((entry) => {
              const Icon = MODE_ICONS[entry];
              return (
                <button
                  key={entry}
                  type="button"
                  {...sectionTab(mode === entry)}
                  data-testid={`mfa-add-mode-${entry}`}
                  className="inline-flex items-center gap-1 rounded-t px-2.5 py-1.5 text-ui-body hover:bg-[var(--taomni-hover)]"
                  style={mode === entry ? { boxShadow: "inset 0 -2px 0 var(--taomni-accent)", fontWeight: 600 } : undefined}
                  onClick={() => setMode(entry)}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t(MODE_LABELS[entry])}
                </button>
              );
            })}
          </SectionTabs>
        ) : null}
        <div className="p-4">
          {preview ? (
            <MfaImportPreview items={preview.items} onBack={() => setPreview(null)} onImported={onAdded} />
          ) : mode === "secret" ? (
            <MfaSecretForm onAdded={onAdded} onCancel={onClose} onParsedItems={(items) => setPreview({ items })} />
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
