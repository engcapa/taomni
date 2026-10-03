import type { MailAddress, MailMessageHeader } from "./mail";
import type { MailIdentity, MailTabInfo } from "../types";

/** Id of the identity built from the account's own address and settings. */
export const DEFAULT_IDENTITY_ID = "default";

/** The account identity followed by the configured aliases (Thunderbird "identities"). */
export function mailIdentities(info: MailTabInfo): MailIdentity[] {
  const primary: MailIdentity = {
    id: DEFAULT_IDENTITY_ID,
    name: info.displayName ?? null,
    email: info.emailAddress,
    replyTo: info.replyTo ?? null,
    signature: info.signature ?? null,
  };
  const extras = (info.identities ?? []).filter((identity) =>
    identity.email.trim() && identity.id !== DEFAULT_IDENTITY_ID);
  return [primary, ...extras];
}

export function identityLabel(identity: MailIdentity): string {
  const name = identity.name?.trim();
  return name ? `${name} <${identity.email}>` : identity.email;
}

/** `From:` value for the send request (`null` = account default). */
export function identityFromHeader(identity: MailIdentity | undefined): string | null {
  if (!identity || identity.id === DEFAULT_IDENTITY_ID) return null;
  return identityLabel(identity);
}

function normalized(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Reply with the identity the original was addressed to (To, then Cc),
 * like Thunderbird; otherwise the account default.
 */
export function pickReplyIdentity(identities: readonly MailIdentity[], target: MailMessageHeader): MailIdentity {
  const recipients: MailAddress[] = [...target.to, ...target.cc];
  for (const recipient of recipients) {
    const address = normalized(recipient.address);
    const match = identities.find((identity) => normalized(identity.email) === address);
    if (match) return match;
  }
  return identities[0];
}

/** Every address the user sends as (excluded from Reply All). */
export function ownIdentityAddresses(identities: readonly MailIdentity[]): string[] {
  return identities.map((identity) => normalized(identity.email)).filter(Boolean);
}

/**
 * Parse the session option (JSON array) into identities, dropping malformed
 * entries.
 */
export function parseMailIdentities(raw: unknown): MailIdentity[] {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const result: MailIdentity[] = [];
  value.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const record = entry as Record<string, unknown>;
    const email = typeof record.email === "string" ? record.email.trim() : "";
    if (!email.includes("@")) return;
    result.push({
      id: typeof record.id === "string" && record.id ? record.id : `identity-${index + 1}`,
      name: typeof record.name === "string" ? record.name : null,
      email,
      replyTo: typeof record.replyTo === "string" && record.replyTo.trim() ? record.replyTo.trim() : null,
      signature: typeof record.signature === "string" ? record.signature : null,
    });
  });
  return result;
}

/**
 * Swap the signature block when the From identity changes. Only an exact,
 * unedited signature block is replaced; otherwise the body is left alone.
 */
export function swapSignature(html: string, previous: string, next: string): string {
  if (previous === next) return html;
  if (previous && html.includes(previous)) return html.replace(previous, next);
  return html;
}
