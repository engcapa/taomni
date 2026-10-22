import "./tests/mailClientTab/harness";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailDraft } from "../../lib/mail";
import { markRecoveryStartup } from "../../lib/runtimeRecovery";
import { useTaoAlertStore } from "../../stores/taoAlertStore";
import { registerMailClientTabClipboard2Cases } from "./tests/mailClientTab/clipboard2.cases";
import { registerMailClientTabEditing1Cases } from "./tests/mailClientTab/editing1.cases";
import { chatState, eventMocks, filterMocks, folder, info, mailMocks, message, messageBody, renderMailbox, stepResult } from "./tests/mailClientTab/harness";
import { registerMailClientTabHistory3Cases } from "./tests/mailClientTab/history3.cases";
import { registerMailClientTabHistory4Cases } from "./tests/mailClientTab/history4.cases";

describe("MailClientTab", () => {
  beforeEach(() => {
    markRecoveryStartup(false);
    for (const mock of Object.values(mailMocks)) mock.mockReset();
    for (const mock of Object.values(chatState)) {
      if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
    }

    mailMocks.mailListCachedFolders.mockResolvedValue([folder]);
    mailMocks.mailListCachedMessages.mockResolvedValue([message]);
    mailMocks.mailGetMessageBody.mockResolvedValue(messageBody);
    mailMocks.mailPrefetchMessageBody.mockResolvedValue(undefined);
    mailMocks.mailIndexCachedContacts.mockResolvedValue(undefined);
    mailMocks.mailListDrafts.mockResolvedValue([]);
    mailMocks.mailMarkRead.mockResolvedValue({ folder: "INBOX", marked: 0 });
    mailMocks.mailSearchContacts.mockResolvedValue([]);
    mailMocks.mailSyncAllFolders.mockResolvedValue({
      accountId: info.sessionId,
      folders: [folder],
      fetchedMessages: 0,
      newMessages: 0,
      cachedBodies: 0,
      syncedAt: 0,
    });
    mailMocks.mailSyncHeaders.mockResolvedValue({
      accountId: info.sessionId,
      folder: "INBOX",
      folders: [folder],
      messages: [message],
      fetchedMessages: 1,
      cachedBodies: 1,
      syncedAt: 0,
      offset: 0,
      limit: 1,
      hasMore: false,
    });
    mailMocks.mailSyncFolder.mockResolvedValue(stepResult({}));
    mailMocks.mailIdleStart.mockResolvedValue(true);
    mailMocks.mailIdleStop.mockResolvedValue(true);
    mailMocks.mailListFolders.mockResolvedValue([]);
    for (const mock of Object.values(filterMocks)) mock.mockReset();
    filterMocks.mailApplyFilters.mockResolvedValue({ folder: "INBOX", examined: 0, matched: 0, moved: 0, errors: [] });
    filterMocks.mailListFilters.mockResolvedValue([]);
    eventMocks.handlers.clear();
    useTaoAlertStore.setState({ aiDone: [], mailNew: [] });
  });

  afterEach(() => {
    markRecoveryStartup(false);
    cleanup();
    vi.useRealTimers();
    useTaoAlertStore.setState({ aiDone: [], mailNew: [] });
  });
  registerMailClientTabEditing1Cases();
  registerMailClientTabClipboard2Cases({
    get useDraftStore() { return useDraftStore; },
  });

  function useDraftStore() {
    const store: MailDraft[] = [];
    mailMocks.mailSaveDraft.mockImplementation(async (_account: string, request: Partial<MailDraft>) => {
      const id = request.id ?? `d${store.length + 1}`;
      const saved = {
        accountId: info.sessionId, to: [], cc: [], bcc: [], subject: "", textBody: "", htmlBody: "",
        attachments: [], createdAt: 1, updatedAt: 1, ...request, id,
      } as MailDraft;
      const index = store.findIndex((item) => item.id === id);
      if (index >= 0) store[index] = saved;
      else store.push(saved);
      return saved;
    });
    mailMocks.mailListDrafts.mockImplementation(async () => [...store]);
    mailMocks.mailDeleteDraft.mockImplementation(async (_account: string, id: string) => {
      const index = store.findIndex((item) => item.id === id);
      if (index >= 0) store.splice(index, 1);
    });
    return store;
  }

  for (const recovering of [false, true]) {
    it(`${recovering ? "recovery pauses" : "cold startup retains"} automatic Outbox sending`, async () => {
      markRecoveryStartup(recovering);
      vi.useFakeTimers();
      const store = useDraftStore();
      store.push({
        id: "pending-send", accountId: info.sessionId, to: ["fixture@example.invalid"],
        cc: [], bcc: [], subject: "fixture only", textBody: "not a real recipient", htmlBody: "",
        attachments: [], createdAt: 1, updatedAt: 1,
        replyContext: { outbox: { sendAt: 1, queuedAt: 1, attempts: 0 } },
      } as MailDraft);
      mailMocks.mailSendMessage.mockResolvedValue({ accepted: true, response: "ok", sentCopyFolder: "Sent" });
      renderMailbox();
      await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
      expect(mailMocks.mailSendMessage).toHaveBeenCalledTimes(recovering ? 0 : 1);
      if (recovering) {
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(mailMocks.mailSendMessage).not.toHaveBeenCalled();
        expect(store).toHaveLength(1);
      } else {
        expect(store).toHaveLength(0);
      }
    });
  }

  async function replyAndReach(testId: string) {
    renderMailbox();
    await screen.findByText(/Second line stays visible/);
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await screen.findByTestId("mail-compose-dialog");
    return screen.getByTestId(testId);
  }
  registerMailClientTabHistory3Cases({
    get useDraftStore() { return useDraftStore; },
    get replyAndReach() { return replyAndReach; },
  });
  registerMailClientTabHistory4Cases();
});
