import { Loader2, ShieldCheck } from "lucide-react";
import { type SetStateAction } from "react";
import { type MailCertificateInfo } from "../../../lib/mail";
import { MailDraggableDialog } from "./MailDraggableDialog";

export interface MailCertificateDialogContext {
  certReview: { protocol: "imap" | "smtp"; loading: boolean; info?: MailCertificateInfo; error?: string; } | null;
  setCertReview: import("react").Dispatch<SetStateAction<{ protocol: "imap" | "smtp"; loading: boolean; info?: MailCertificateInfo; error?: string; } | null>>;
  trustReviewedCertificate: () => Promise<void>;
}

export function MailCertificateDialog(context: MailCertificateDialogContext) {
  const { certReview, setCertReview, trustReviewedCertificate } = context;
  return certReview && (
    <div className="absolute inset-0 z-[150] bg-black/30 flex items-center justify-center p-5">
      <MailDraggableDialog
        title={`${certReview.protocol.toUpperCase()} server certificate`}
        icon={<ShieldCheck className="w-4 h-4 text-[var(--taomni-text-muted)]" />}
        ariaLabel="Server certificate"
        minWidth={420}
        minHeight={260}
        className="w-[min(620px,92vw)] min-h-[280px]"
        onClose={() => setCertReview(null)}
      >
        <div className="flex-1 min-h-0 overflow-auto p-3 text-[12px] flex flex-col gap-2" data-testid="mail-cert-dialog">
          {certReview.loading && (
            <div className="flex items-center gap-2 text-[var(--taomni-text-muted)]">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Fetching the certificate…
            </div>
          )}
          {certReview.error && <div className="text-red-500">{certReview.error}</div>}
          {certReview.info && (
            <>
              <div className="text-[var(--taomni-warning,#d97706)]">
                {certReview.info.trustedBySystem
                  ? "This certificate is trusted by the system."
                  : `Not trusted by the system: ${certReview.info.verifyError ?? "unknown issuer"}`}
              </div>
              <div className="grid grid-cols-[92px_1fr] gap-x-2 gap-y-1">
                <span className="text-[var(--taomni-text-muted)]">Server</span>
                <span>{certReview.info.host}:{certReview.info.port}</span>
                <span className="text-[var(--taomni-text-muted)]">Subject</span>
                <span className="break-all">{certReview.info.subject || "(none)"}</span>
                <span className="text-[var(--taomni-text-muted)]">Issuer</span>
                <span className="break-all">{certReview.info.issuer || "(none)"}</span>
                <span className="text-[var(--taomni-text-muted)]">Valid</span>
                <span>{certReview.info.notBefore} – {certReview.info.notAfter}</span>
                <span className="text-[var(--taomni-text-muted)]">SHA-256</span>
                <code className="break-all font-mono text-[11px]" data-testid="mail-cert-fingerprint">
                  {certReview.info.sha256}
                </code>
              </div>
              <div className="text-[11px] text-[var(--taomni-text-muted)]">
                Compare the fingerprint with the one your mail administrator gave you. Only this exact
                certificate will be accepted for this server; if it changes you will be asked again.
              </div>
            </>
          )}
        </div>
        <div className="h-10 px-3 flex items-center justify-end gap-2 border-t border-[var(--taomni-divider)]">
          <button type="button" className="taomni-btn h-7 px-3 text-[12px]" onClick={() => setCertReview(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="taomni-btn h-7 px-3 text-[12px]"
            data-primary="true"
            data-testid="mail-cert-trust"
            disabled={!certReview.info}
            onClick={() => void trustReviewedCertificate()}
          >
            Trust for this account
          </button>
        </div>
      </MailDraggableDialog>
    </div>
  );
}
