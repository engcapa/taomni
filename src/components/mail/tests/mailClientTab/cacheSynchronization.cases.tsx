import { act, render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import type { MailMessageHeader } from "../../../../lib/mail";
import { MailClientTab } from "../../MailClientTab";
import { info, mailMocks, message, stepResult } from "./harness";

export function registerMailCacheSynchronizationCases() {
  it("loads headers cached by the archive even when foreground sync fetches nothing", async () => {
    mailMocks.mailListCachedMessages.mockResolvedValue([message]);
    mailMocks.mailListCachedMessages.mockResolvedValueOnce([]);
    // The archive has published these headers before the foreground sync's
    // watermark read. No new headers in that sync does not mean an empty cache.
    mailMocks.mailSyncFolder.mockResolvedValue(stepResult({}));

    render(<MailClientTab tabId="mail-tab" info={{ ...info, sync: { ...info.sync, onOpen: true } }} visible />);

    await waitFor(() => expect(mailMocks.mailSyncFolder).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("mail-message-count")).toHaveAttribute("data-count", "1"));
    expect(screen.getByTestId("mail-message-row")).toHaveTextContent(message.subject);
  });

  it("keeps the post-sync cache page when the initial empty snapshot arrives late", async () => {
    let finishInitial!: (value: MailMessageHeader[]) => void;
    mailMocks.mailListCachedMessages.mockResolvedValue([message]);
    mailMocks.mailListCachedMessages.mockImplementationOnce(() => new Promise((resolve) => { finishInitial = resolve; }));
    mailMocks.mailSyncFolder.mockResolvedValue(stepResult({ messages: [message], fetched: 1 }));

    render(<MailClientTab tabId="mail-tab" info={{ ...info, sync: { ...info.sync, onOpen: true } }} visible />);

    await waitFor(() => expect(mailMocks.mailListCachedMessages).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("mail-message-count")).toHaveAttribute("data-count", "1"));
    await act(async () => finishInitial([]));
    expect(screen.getByTestId("mail-message-count")).toHaveAttribute("data-count", "1");
    expect(screen.getByTestId("mail-message-row")).toHaveTextContent(message.subject);
  });
}
