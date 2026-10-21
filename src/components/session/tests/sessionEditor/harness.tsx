import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { vi } from "vitest";
import { AppDialogProvider } from "../../../../lib/appDialogs";
import { SessionEditor } from "../../SessionEditor";

const ipcMocks = vi.hoisted(() => ({
  testSshConnection: vi.fn(),
  listSessions: vi.fn(),
  getSession: vi.fn(),
  saveSession: vi.fn(),
  deleteSession: vi.fn(),
  markSessionConnected: vi.fn(),
  listSessionGroups: vi.fn(),
  saveSessionGroup: vi.fn(),
  deleteSessionGroup: vi.fn(),
  listSystemFonts: vi.fn(),
  listWslDistros: vi.fn(),
  listLocalShells: vi.fn(),
  hbaseTestConnection: vi.fn(),
  dbTestConnection: vi.fn(),
  vaultPut: vi.fn(async () => ({ id: "vault-pwd", reference: "vault:pwd" })),
  isVaultReference: (val: string) => typeof val === "string" && val.startsWith("vault:"),
  isVaultLockedError: (_err: any) => false,
}));

const mailMocks = vi.hoisted(() => ({
  mailOAuthAuthorize: vi.fn(async () => ({
    tokenRef: "vault:oauth-token",
    expiresAt: 1_800_000_000,
    scope: "mail.scope",
    tokenType: "Bearer",
  })),
  mailOAuthDeviceStart: vi.fn(async () => ({
    deviceCode: "device-code",
    userCode: "ABCD-EFGH",
    verificationUri: "https://microsoft.com/devicelogin",
    message: "Use code ABCD-EFGH",
    expiresIn: 900,
    interval: 1,
  })),
  mailOAuthDeviceComplete: vi.fn(async () => ({
    tokenRef: "vault:oauth-token",
    expiresAt: 1_800_000_000,
    scope: "mail.scope",
    tokenType: "Bearer",
  })),
}));

vi.mock("../../../../lib/ipc", () => ({
  ...ipcMocks,
}));

vi.mock("../../../../lib/mail", () => ({
  ...mailMocks,
}));

vi.mock("../../../../lib/runtime", () => ({
  getAppPlatform: () => "windows",
  isTauriRuntime: () => true,
}));

vi.mock("../../../../lib/vaultGate", () => ({
  ensureVaultReady: vi.fn(async () => true),
}));

export function renderEditor(
  session?: ComponentProps<typeof SessionEditor>["session"],
  props: Partial<Omit<ComponentProps<typeof SessionEditor>, "session" | "onClose">> = {},
) {
  const onClose = vi.fn();
  render(
    <AppDialogProvider>
      <SessionEditor session={session} onClose={onClose} {...props} />
    </AppDialogProvider>,
  );
  return { onClose };
}

export function checkboxInLabel(text: string): HTMLInputElement {
  const input = screen.getByText(text).closest("label")?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error(`Checkbox not found: ${text}`);
  return input;
}

export { ipcMocks, mailMocks };
