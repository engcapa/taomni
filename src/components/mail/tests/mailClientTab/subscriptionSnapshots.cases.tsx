import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import type { MailFolder, MailSyncAllResult } from "../../../../lib/mail";
import { MailClientTab } from "../../MailClientTab";
import { folder, info, mailMocks } from "./harness";

export function registerMailSubscriptionSnapshotCases() {
  for (const source of ["LIST", "full sync"] as const) {
    it(`keeps a confirmed subscription change when an older ${source} snapshot arrives`, async () => {
      window.localStorage.removeItem(`taomni.mail.subscribedOnly:${info.sessionId}`);
      const inbox: MailFolder = { ...folder, flags: ["\\Subscribed"] };
      const archive: MailFolder = { ...folder, name: "Archive", displayName: "Archive", flags: ["\\Subscribed"] };
      const unsubscribed = { ...archive, flags: [] };
      const initial = [inbox, archive];
      let finishList!: (value: MailFolder[]) => void;
      let finishSync!: (value: MailSyncAllResult) => void;
      mailMocks.mailListCachedFolders.mockResolvedValue(initial);
      mailMocks.mailSetFolderSubscription.mockImplementation(async () => {
        mailMocks.mailListCachedFolders.mockResolvedValue([inbox, unsubscribed]);
        return [inbox, unsubscribed];
      });
      if (source === "LIST") {
        mailMocks.mailListFolders.mockImplementationOnce(() => new Promise((resolve) => { finishList = resolve; }));
      } else {
        mailMocks.mailSyncAllFolders.mockImplementationOnce(() => new Promise((resolve) => { finishSync = resolve; }));
      }
      render(<MailClientTab tabId="mail-tab" info={{ ...info, sync: { ...info.sync, onOpen: source === "LIST" } }} visible />);
      const row = () => document.querySelector('[data-testid="mail-subscription-row"][data-folder-name="Archive"]') as HTMLElement;
      await waitFor(() => expect(document.querySelector('[data-testid="mail-folder-row"][data-folder-name="Archive"]')).not.toBeNull());
      if (source === "full sync") fireEvent.click(screen.getByTestId("mail-sync-button"));
      await waitFor(() => expect(source === "LIST" ? finishList : finishSync).toBeDefined());
      fireEvent.click(screen.getByTestId("mail-subscriptions-open"));
      fireEvent.click(within(row()).getByTestId("mail-subscription-toggle"));
      await waitFor(() => expect(row()).toHaveAttribute("data-subscribed", "false"));
      await act(async () => {
        if (source === "LIST") finishList(initial);
        else finishSync({ accountId: info.sessionId, folders: initial, fetchedMessages: 0,
          newMessages: 0, cachedBodies: 0, syncedAt: 0 });
      });
      expect(row()).toHaveAttribute("data-subscribed", "false");
      fireEvent.click(screen.getByTestId("mail-subscribed-only"));
      expect(document.querySelector('[data-testid="mail-folder-row"][data-folder-name="Archive"]')).toBeNull();
      window.localStorage.removeItem(`taomni.mail.subscribedOnly:${info.sessionId}`);
    });
  }
}
