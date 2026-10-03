import { useState } from "react";
import { ScanLine } from "lucide-react";
import { useT } from "../../lib/i18n";
import { errorText, mfaErrorCode } from "../../lib/mfa/format";
import { mfaCaptureScreens } from "../../lib/mfa/ipc";
import { decodeLumaFrames } from "../../lib/mfa/qrImage";
import type { MfaTextsOutcome } from "./MfaImagePane";

type ScanState = { kind: "idle" } | { kind: "busy" } | { kind: "error"; message: string };

/** In-app screen scan: the backend hides Taomni, captures every display and restores it. */
export function MfaScreenPane({ onTexts }: { onTexts: (texts: string[]) => MfaTextsOutcome }) {
  const t = useT();
  const [state, setState] = useState<ScanState>({ kind: "idle" });

  const scan = async () => {
    setState({ kind: "busy" });
    try {
      const texts = await decodeLumaFrames(await mfaCaptureScreens());
      if (texts.length === 0) {
        setState({ kind: "error", message: t("mfa.screenNoQr") });
        return;
      }
      const outcome = onTexts(texts);
      setState(outcome.ok ? { kind: "idle" } : { kind: "error", message: outcome.message });
    } catch (err) {
      const code = mfaErrorCode(err);
      const message =
        code === "MFA_DESKTOP_ONLY"
          ? t("mfa.screenDesktopOnly")
          : code === "MFA_SCREEN_PERMISSION"
            ? t("mfa.screenPermission")
            : t("mfa.screenFailed", { error: errorText(err) });
      setState({ kind: "error", message });
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-[12px]" style={{ color: "var(--taomni-text-muted)" }}>{t("mfa.screenHint")}</p>
      <button
        type="button"
        data-testid="mfa-screen-scan"
        className="inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-[12px] text-white disabled:opacity-50"
        style={{ background: "var(--taomni-accent)" }}
        disabled={state.kind === "busy"}
        onClick={() => void scan()}
      >
        <ScanLine className="h-3.5 w-3.5" />
        {t("mfa.screenScan")}
      </button>
      <div
        data-testid="mfa-screen-status"
        data-state={state.kind}
        role="status"
        aria-live="polite"
        className="min-h-[18px] text-[12px]"
        style={{ color: state.kind === "error" ? "var(--taomni-error, #c33)" : "var(--taomni-text-muted)" }}
      >
        {state.kind === "busy" ? t("mfa.screenScanning") : state.kind === "error" ? state.message : ""}
      </div>
    </div>
  );
}
