import { useAppStore } from "../../stores/appStore";
import { useChatStore } from "../../stores/chatStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useTaoAlertStore } from "../../stores/taoAlertStore";
import { parseSessionOptions } from "../terminalProfile";

export function pushMailNotification(tabId: string, accountId: string, title: string, count: number) {
  useTaoAlertStore.getState().pushMailNew(tabId, accountId, title, count);
}

export function openMailTabChat(tabId: string): Promise<void> {
  return useChatStore.getState().openTabChat(tabId);
}

export async function sendMailContextToAi(tabId: string, prompt: string): Promise<void> {
  await openMailTabChat(tabId);
  const { activeThreadId, sendMessage } = useChatStore.getState();
  if (!activeThreadId) throw new Error("No AI chat thread is available.");
  await sendMessage(activeThreadId, prompt);
}

/** Saved accounts keep their exception. A Quick Connect tab keeps it in memory. */
export async function rememberMailCertificate(
  tabId: string,
  accountId: string,
  protocol: "imap" | "smtp",
  certificate: string,
): Promise<boolean> {
  const store = useSessionStore.getState();
  const session = store.sessions.find((entry) => entry.id === accountId);
  if (session) {
    const options = parseSessionOptions(session.options_json);
    const key = protocol === "smtp" ? "mailSmtpTrustedCert" : "mailImapTrustedCert";
    await store.updateSession({ ...session, options_json: JSON.stringify({ ...options, [key]: certificate }) });
  }
  useAppStore.setState((state) => ({
    tabs: state.tabs.map((tab) => {
      if (tab.id !== tabId || tab.mail?.sessionId !== accountId) return tab;
      const mail = { ...tab.mail, [protocol]: { ...tab.mail[protocol], trustedCert: certificate } };
      return { ...tab, mail };
    }),
  }));
  return Boolean(session);
}
