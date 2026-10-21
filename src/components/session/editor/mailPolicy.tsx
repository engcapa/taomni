import { type SelectOption } from "./Fields";

export type MailSecurityMode = "TLS" | "STARTTLS" | "None";

export type MailProvider = "custom" | "gmail" | "outlook";

export type MailAuthMode = "password" | "oauth2";

export type MailOAuthFlow = "browser" | "device";


export interface MailOAuthDeviceInfo {
  userCode: string;
  verificationUri: string;
  message: string;
  expiresIn: number;
}


export interface MailProviderPreset {
  imapHost: string;
  imapPort: string;
  imapSecurity: MailSecurityMode;
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: MailSecurityMode;
  smtpUseImapAuth: boolean;
}


export const MAIL_PROVIDER_PRESETS: Partial<Record<MailProvider, MailProviderPreset>> = {
  gmail: {
    imapHost: "imap.gmail.com",
    imapPort: "993",
    imapSecurity: "TLS",
    smtpHost: "smtp.gmail.com",
    smtpPort: "587",
    smtpSecurity: "STARTTLS",
    smtpUseImapAuth: true,
  },
  outlook: {
    imapHost: "outlook.office365.com",
    imapPort: "993",
    imapSecurity: "TLS",
    smtpHost: "smtp-mail.outlook.com",
    smtpPort: "587",
    smtpSecurity: "STARTTLS",
    smtpUseImapAuth: true,
  },
};


export const MAIL_PROVIDER_OPTIONS: SelectOption[] = [
  { value: "custom", label: "Custom IMAP/SMTP" },
  { value: "gmail", label: "Gmail" },
  { value: "outlook", label: "Outlook.com" },
];


export const MAIL_AUTH_MODE_OPTIONS: SelectOption[] = [
  { value: "oauth2", label: "OAuth2 / Modern Auth" },
  { value: "password", label: "Password / app password" },
];


export const MAIL_OAUTH_FLOW_OPTIONS: SelectOption[] = [
  { value: "device", label: "Device code" },
  { value: "browser", label: "Browser callback" },
];


export function normalizeMailProvider(value: unknown): MailProvider | null {
  if (value === "gmail" || value === "outlook" || value === "custom") return value;
  return null;
}


export function normalizeMailAuthMode(value: unknown): MailAuthMode {
  return value === "oauth2" ? "oauth2" : "password";
}


export function normalizeMailOAuthFlow(value: unknown): MailOAuthFlow | null {
  if (value === "browser" || value === "device") return value;
  return null;
}


export function defaultMailOAuthFlow(provider: MailProvider): MailOAuthFlow {
  return provider === "outlook" ? "device" : "browser";
}


export function supportsMailOAuthProvider(provider: MailProvider): provider is "gmail" | "outlook" {
  return provider === "gmail" || provider === "outlook";
}


export function effectiveMailOAuthFlow(provider: MailProvider, flow: MailOAuthFlow): MailOAuthFlow {
  return supportsMailOAuthProvider(provider) && flow === "device" ? "device" : "browser";
}


export function mailOAuthClientSecretVisible(provider: MailProvider, flow: MailOAuthFlow): boolean {
  return !(provider === "outlook" && effectiveMailOAuthFlow(provider, flow) === "device");
}


export function mailOAuthClientSecretRequired(provider: MailProvider, flow: MailOAuthFlow): boolean {
  return provider === "gmail" && effectiveMailOAuthFlow(provider, flow) === "device";
}


export function initialMailOAuthFlow(options: Record<string, unknown>, provider: MailProvider): MailOAuthFlow {
  return normalizeMailOAuthFlow(options.mailOauthFlow) ?? defaultMailOAuthFlow(provider);
}


export function initialMailProvider(options: Record<string, unknown>, imapHost: string | undefined): MailProvider {
  const explicit = normalizeMailProvider(options.mailProvider);
  if (explicit) return explicit;

  const host = (imapHost ?? "").trim().toLowerCase();
  if (host === MAIL_PROVIDER_PRESETS.gmail?.imapHost) return "gmail";
  if (host === MAIL_PROVIDER_PRESETS.outlook?.imapHost) return "outlook";
  return "custom";
}


export function stripMailIdentityOptions(options: Record<string, unknown>): Record<string, unknown> {
  const next = { ...options };
  delete next.mailEmailAddress;
  return next;
}
