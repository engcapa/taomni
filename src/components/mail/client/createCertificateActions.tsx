import { type SetStateAction } from "react";
import { mailProbeCertificate, type MailCertificateInfo } from "../../../lib/mail";
import { useAppStore } from "../../../stores/appStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { mailClientErrorMessage } from "./messages";


export interface CreateCertificateActionsContext {
  setCertReview: import("react").Dispatch<SetStateAction<{ protocol: "imap" | "smtp"; loading: boolean; info?: MailCertificateInfo; error?: string; } | null>>;
  info: import("../../../types").MailTabInfo;
  certReview: { protocol: "imap" | "smtp"; loading: boolean; info?: MailCertificateInfo; error?: string; } | null;
  setError: import("react").Dispatch<SetStateAction<string | null>>;
  tabId: string;
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
  retryAfterTrustRef: import("react").RefObject<boolean>;
}

export function createCertificateActions(context: CreateCertificateActionsContext) {
  const { setCertReview, info, certReview, setError, tabId, setStatus, retryAfterTrustRef } = context;

  /** AC-44: show the server certificate so the user can add an exception. */
  const openCertReview = async (protocol: "imap" | "smtp") => {
    setCertReview({ protocol, loading: true });
    try {
      const cert = await mailProbeCertificate(info, protocol);
      setCertReview({ protocol, loading: false, info: cert });
    } catch (e) {
      setCertReview({ protocol, loading: false, error: mailClientErrorMessage(e) });
    }
  };

  const trustReviewedCertificate = async () => {
    const review = certReview;
    if (!review?.info) return;
    const der = review.info.derBase64;
    const key = review.protocol === "smtp" ? "mailSmtpTrustedCert" : "mailImapTrustedCert";
    // Persist on the saved session (quick-connect tabs keep it in memory).
    const store = useSessionStore.getState();
    const session = store.sessions.find((entry) => entry.id === info.sessionId);
    if (session) {
      let options: Record<string, unknown> = {};
      try {
        options = JSON.parse(session.options_json || "{}") as Record<string, unknown>;
      } catch {
        options = {};
      }
      options[key] = der;
      try {
        await store.updateSession({ ...session, options_json: JSON.stringify(options) });
      } catch (e) {
        setError(mailClientErrorMessage(e));
        return;
      }
    }
    useAppStore.setState((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.id !== tabId || !tab.mail) return tab;
        const mail = review.protocol === "smtp"
          ? { ...tab.mail, smtp: { ...tab.mail.smtp, trustedCert: der } }
          : { ...tab.mail, imap: { ...tab.mail.imap, trustedCert: der } };
        return { ...tab, mail };
      }),
    }));
    setCertReview(null);
    setError(null);
    setStatus(session
      ? "Certificate trusted for this account; reconnecting…"
      : "Certificate trusted until this tab closes (save the account to keep it); reconnecting…");
    retryAfterTrustRef.current = true;
  };
  return { openCertReview, trustReviewedCertificate };
}
