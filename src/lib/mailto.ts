/** Parsed `mailto:` URI (RFC 6068). */
export interface MailtoFields {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, "%20"));
  } catch {
    return value;
  }
}

function addresses(value: string): string[] {
  return decode(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Parse `mailto:a@x,b@x?cc=c@x&subject=Hi&body=...`; null when not mailto. */
export function parseMailto(href: string): MailtoFields | null {
  const match = /^mailto:([^?#]*)(?:\?([^#]*))?/i.exec(href.trim());
  if (!match) return null;
  const fields: MailtoFields = { to: addresses(match[1] ?? ""), cc: [], bcc: [], subject: "", body: "" };
  for (const pair of (match[2] ?? "").split("&")) {
    if (!pair) continue;
    const [rawKey, ...rest] = pair.split("=");
    const key = decode(rawKey).toLowerCase();
    const value = rest.join("=");
    if (key === "to") fields.to.push(...addresses(value));
    else if (key === "cc") fields.cc.push(...addresses(value));
    else if (key === "bcc") fields.bcc.push(...addresses(value));
    else if (key === "subject") fields.subject = decode(value);
    else if (key === "body") fields.body = decode(value);
  }
  return fields;
}
