import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailAddressBookEntry } from "../../lib/mailContacts";
import type { MailTabInfo } from "../../types";

const contactMocks = vi.hoisted(() => ({
  mailListAddressBook: vi.fn(),
  mailSaveAddressBookEntry: vi.fn(),
  mailDeleteAddressBookEntry: vi.fn(),
  mailImportVcards: vi.fn(),
  mailExportVcards: vi.fn(),
  mailCardDavSync: vi.fn(),
}));

vi.mock("../../lib/mailContacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/mailContacts")>()),
  ...contactMocks,
}));

import { MailAddressBookPanel } from "./MailAddressBookPanel";

const jane: MailAddressBookEntry = {
  uid: "u1",
  book: "local",
  displayName: "Jane Doe",
  emails: ["jane@example.com"],
  phones: ["+1 555"],
  org: "Acme",
};
const bob: MailAddressBookEntry = { uid: "u2", book: "carddav", displayName: "Bob", emails: ["bob@example.com"], phones: [], pendingSync: true };

const info = { sessionId: "acct", emailAddress: "me@example.com" } as unknown as MailTabInfo;

describe("MailAddressBookPanel", () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    for (const mock of Object.values(contactMocks)) mock.mockReset();
    contactMocks.mailListAddressBook.mockResolvedValue([jane, bob]);
  });

  it("lists, searches, adds and deletes contacts", async () => {
    const onStatus = vi.fn();
    render(<MailAddressBookPanel info={info} onStatus={onStatus} />);
    expect(await screen.findAllByTestId("mail-contact-row")).toHaveLength(2);
    expect(screen.queryByTestId("mail-carddav-sync")).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId("mail-contact-search"), { target: { value: "acme" } });
    expect(screen.getAllByTestId("mail-contact-row")).toHaveLength(1);
    fireEvent.change(screen.getByTestId("mail-contact-search"), { target: { value: "" } });

    contactMocks.mailSaveAddressBookEntry.mockImplementation(async (_: MailTabInfo, entry: MailAddressBookEntry) => ({ ...entry, uid: "u3", book: "local" }));
    fireEvent.click(screen.getByTestId("mail-contact-new"));
    const save = screen.getByTestId("mail-contact-save");
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByTestId("mail-contact-name"), { target: { value: "Carol" } });
    fireEvent.change(screen.getByTestId("mail-contact-email"), { target: { value: " carol@example.com " } });
    fireEvent.click(screen.getByText("Email", { selector: "button" }));
    fireEvent.click(save);
    await waitFor(() => expect(contactMocks.mailSaveAddressBookEntry).toHaveBeenCalledWith(info, expect.objectContaining({
      displayName: "Carol",
      emails: ["carol@example.com"],
      phones: [],
    })));
    expect(onStatus).toHaveBeenCalledWith("Saved Carol");

    contactMocks.mailDeleteAddressBookEntry.mockResolvedValue(true);
    const row = (await screen.findAllByTestId("mail-contact-row")).find((item) => item.dataset.contactName === "Bob")!;
    fireEvent.click(within(row).getByTestId("mail-contact-delete"));
    await waitFor(() => expect(contactMocks.mailDeleteAddressBookEntry).toHaveBeenCalledWith("acct", "u2"));
  });

  it("syncs CardDAV and shows per-card errors", async () => {
    contactMocks.mailCardDavSync.mockResolvedValue({
      collection: "https://dav.example/book/",
      pulled: 3,
      removed: 0,
      pushed: 1,
      conflicts: 1,
      errors: ["upload Bob: HTTP 507"],
    });
    const onStatus = vi.fn();
    render(<MailAddressBookPanel info={{ ...info, carddav: { url: "https://dav.example/" } }} onStatus={onStatus} />);
    const sync = await screen.findByTestId("mail-carddav-sync");
    expect(sync).toHaveTextContent("Sync (1)");
    fireEvent.click(sync);
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith(
      "CardDAV sync: 3 updated from the server, 1 uploaded, 1 conflict (server copy kept), 1 error",
    ));
    expect(screen.getByTestId("mail-carddav-errors")).toHaveTextContent("HTTP 507");
    expect(contactMocks.mailListAddressBook).toHaveBeenCalledTimes(2);
  });

  it("edits a pre-filled draft and composes to a contact", async () => {
    const onCompose = vi.fn();
    render(<MailAddressBookPanel info={info} initialDraft={{ ...jane, uid: "", emails: ["new@example.com"] }} onCompose={onCompose} />);
    expect(await screen.findByTestId("mail-contact-editor")).toBeInTheDocument();
    expect(screen.getByTestId("mail-contact-email")).toHaveValue("new@example.com");
    fireEvent.click(screen.getByText("Cancel"));
    const row = (await screen.findAllByTestId("mail-contact-row"))[0];
    fireEvent.click(within(row).getByTestId("mail-contact-compose"));
    expect(onCompose).toHaveBeenCalledWith(jane);
  });
});
