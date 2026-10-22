import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { ipcMocks, mailMocks, renderEditor } from "./harness";

export function registerSessionEditorLifecycle4Cases() {

  it("authorizes Gmail OAuth with device code and client secret", async () => {
    const user = userEvent.setup();
    renderEditor(undefined, { initialProto: "Mail" });

    await user.selectOptions(screen.getByLabelText("Mail provider"), "gmail");
    await user.selectOptions(screen.getByLabelText("OAuth flow"), "device");
    await user.type(screen.getByLabelText("Mail email or username"), "me@gmail.com");
    await user.type(screen.getByLabelText("OAuth client ID"), "google-device-client-id");
    await user.type(screen.getByLabelText("OAuth client secret"), "google-device-secret");

    await user.click(screen.getByTestId("mail-oauth-connect"));

    await waitFor(() => expect(mailMocks.mailOAuthDeviceStart).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mailMocks.mailOAuthDeviceComplete).toHaveBeenCalledTimes(1));
    expect(mailMocks.mailOAuthAuthorize).not.toHaveBeenCalled();

    const startRequest = (mailMocks.mailOAuthDeviceStart.mock.calls[0] as unknown[])[0];
    expect(startRequest).toMatchObject({
      provider: "gmail",
      emailAddress: "me@gmail.com",
      clientId: "google-device-client-id",
    });
    const completeRequest = (mailMocks.mailOAuthDeviceComplete.mock.calls[0] as unknown[])[0];
    expect(completeRequest).toMatchObject({
      provider: "gmail",
      emailAddress: "me@gmail.com",
      clientId: "google-device-client-id",
      clientSecret: "google-device-secret",
      deviceCode: "device-code",
      interval: 1,
      expiresIn: 900,
    });
    expect(screen.getByText("OAuth2 connected.")).toBeInTheDocument();
  });

  it("persists Gmail device OAuth flow and client secret vault reference", async () => {
    const user = userEvent.setup();
    const { onClose } = renderEditor(undefined, { initialProto: "Mail" });

    await user.selectOptions(screen.getByLabelText("Mail provider"), "gmail");
    await user.selectOptions(screen.getByLabelText("OAuth flow"), "device");
    await user.type(screen.getByLabelText("Mail email or username"), "me@gmail.com");
    await user.type(screen.getByLabelText("OAuth client ID"), "google-device-client-id");
    await user.type(screen.getByLabelText("OAuth client secret"), "google-device-secret");
    await user.click(screen.getByTestId("mail-oauth-connect"));
    await waitFor(() => expect(screen.getByText("OAuth2 connected.")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(ipcMocks.vaultPut).toHaveBeenCalledWith(
      "mail-oauth-client-secret",
      "me@gmail.com OAuth client secret",
      "google-device-secret",
    );
    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    const savedOptions = JSON.parse(savedConfig.options_json);
    expect(savedOptions.mailProvider).toBe("gmail");
    expect(savedOptions.mailAuthMode).toBe("oauth2");
    expect(savedOptions.mailOauthFlow).toBe("device");
    expect(savedOptions.mailOauthClientId).toBe("google-device-client-id");
    expect(savedOptions.mailOauthClientSecretRef).toBe("vault:pwd");
    expect(savedOptions.mailOauthTokenRef).toBe("vault:oauth-token");
  });

  it("authorizes Outlook OAuth with device code using the Mail Network tab settings", async () => {
    const user = userEvent.setup();
    renderEditor(undefined, { initialProto: "Mail" });

    await user.selectOptions(screen.getByLabelText("Mail provider"), "outlook");
    await user.type(screen.getByLabelText("Mail email or username"), "me@outlook.com");
    await user.type(screen.getByLabelText("OAuth client ID"), "azure-client-id");
    expect(screen.getByLabelText("OAuth flow")).toHaveValue("device");
    expect(screen.queryByLabelText("OAuth client secret")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /network settings/i }));
    const proxySelect = screen.getByDisplayValue("None — direct connection");
    await user.selectOptions(proxySelect, "SOCKS 5");
    await user.type(screen.getByLabelText("Proxy host"), "socks.mail.corp");
    await user.type(screen.getByLabelText("Proxy port"), "1080");

    await user.click(screen.getByRole("button", { name: /mail account/i }));
    await user.click(screen.getByTestId("mail-oauth-connect"));

    await waitFor(() => expect(mailMocks.mailOAuthDeviceStart).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mailMocks.mailOAuthDeviceComplete).toHaveBeenCalledTimes(1));
    expect(mailMocks.mailOAuthAuthorize).not.toHaveBeenCalled();

    const startRequest = (mailMocks.mailOAuthDeviceStart.mock.calls[0] as unknown[])[0];
    expect(startRequest).toMatchObject({
      provider: "outlook",
      emailAddress: "me@outlook.com",
      clientId: "azure-client-id",
      networkSettings: {
        proxyKind: "socks5",
        proxyHost: "socks.mail.corp",
        proxyPort: 1080,
      },
    });
    const completeRequest = (mailMocks.mailOAuthDeviceComplete.mock.calls[0] as unknown[])[0];
    expect(completeRequest).toMatchObject({
      provider: "outlook",
      emailAddress: "me@outlook.com",
      clientId: "azure-client-id",
      deviceCode: "device-code",
      interval: 1,
      expiresIn: 900,
      networkSettings: {
        proxyKind: "socks5",
        proxyHost: "socks.mail.corp",
        proxyPort: 1080,
      },
    });
    expect(screen.getByText("OAuth2 connected.")).toBeInTheDocument();
  });

  it("authorizes Outlook OAuth with browser callback when selected", async () => {
    const user = userEvent.setup();
    renderEditor(undefined, { initialProto: "Mail" });

    await user.selectOptions(screen.getByLabelText("Mail provider"), "outlook");
    await user.selectOptions(screen.getByLabelText("OAuth flow"), "browser");
    await user.type(screen.getByLabelText("Mail email or username"), "me@outlook.com");
    await user.type(screen.getByLabelText("OAuth client ID"), "azure-client-id");
    await user.type(screen.getByLabelText("OAuth client secret"), "azure-client-secret");

    await user.click(screen.getByTestId("mail-oauth-connect"));

    await waitFor(() => expect(mailMocks.mailOAuthAuthorize).toHaveBeenCalledTimes(1));
    expect(mailMocks.mailOAuthDeviceStart).not.toHaveBeenCalled();
    expect(mailMocks.mailOAuthDeviceComplete).not.toHaveBeenCalled();

    const oauthRequest = (mailMocks.mailOAuthAuthorize.mock.calls[0] as unknown[])[0];
    expect(oauthRequest).toMatchObject({
      provider: "outlook",
      emailAddress: "me@outlook.com",
      clientId: "azure-client-id",
      clientSecret: "azure-client-secret",
    });
    expect(screen.getByText("OAuth2 connected.")).toBeInTheDocument();
  });

  it("defaults new mail sessions to follow the application theme", async () => {
    const user = userEvent.setup();
    const { onClose } = renderEditor(undefined, { initialProto: "Mail" });

    await user.type(screen.getByLabelText("IMAP server"), "imap.example.com");
    await user.type(screen.getByLabelText("Mail email or username"), "me@example.com");
    await user.type(screen.getByLabelText("Mail password or app password token"), "imap-secret");
    await user.type(screen.getByLabelText("SMTP server"), "smtp.example.com");

    await user.click(screen.getByRole("button", { name: /appearance/i }));
    expect(await screen.findByTestId("mail-appearance-settings")).toBeInTheDocument();
    const systemTheme = await screen.findByTestId("mail-theme-select");
    expect(systemTheme).toHaveTextContent("Match app theme");

    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1);
    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    const savedOptions = JSON.parse(savedConfig.options_json);

    expect(savedConfig.session_type).toBe("Mail");
    expect(savedOptions.terminalProfile).toMatchObject({
      theme: "system",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
}
