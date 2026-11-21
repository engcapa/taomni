import { type SetStateAction } from "react";
import { mailProbeCertificate, type MailCertificateInfo } from "../../../../../src/lib/mail";
import { rememberMailCertificate } from "../../../../../src/lib/mail/rendererServices";
import { mailClientErrorMessage } from "./messages";


export interface CreateCertificateActionsContext {
  setCertReview: import("react").Dispatch<SetStateAction<{ protocol: "imap" | "smtp"; loading: boolean; info?: MailCertificateInfo; error?: string; } | null>>;
  info: import("../../../../../src/types").MailTabInfo;
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
    let saved: boolean;
    try {
      saved = await rememberMailCertificate(tabId, info.sessionId, review.protocol, review.info.derBase64);
    } catch (e) {
      setError(mailClientErrorMessage(e));
      return;
    }
    setCertReview(null);
    setError(null);
    setStatus(saved
      ? "Certificate trusted for this account; reconnecting…"
      : "Certificate trusted until this tab closes (save the account to keep it); reconnecting…");
    retryAfterTrustRef.current = true;
  };
  return { openCertReview, trustReviewedCertificate };
}
