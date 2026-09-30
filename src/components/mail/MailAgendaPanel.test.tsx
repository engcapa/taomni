import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailTabInfo } from "../../types";

const calendarMocks = vi.hoisted(() => ({
  mailListAgenda: vi.fn(),
  mailCalDavSync: vi.fn(),
}));

vi.mock("../../lib/mailCalendar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/mailCalendar")>()),
  ...calendarMocks,
}));

import { MailAgendaPanel } from "./MailAgendaPanel";

const info = { sessionId: "acct", caldav: { url: "https://dav.example/" } } as unknown as MailTabInfo;

describe("MailAgendaPanel", () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    for (const mock of Object.values(calendarMocks)) mock.mockReset();
  });

  it("lists upcoming events by day and syncs", async () => {
    calendarMocks.mailListAgenda.mockResolvedValue([
      { uid: "b", summary: "Review", startLocal: "2026-10-06T09:00", allDay: false, instance: "", location: "Room 2", alarmMinutes: 10 },
      { uid: "a", summary: "Standup", startLocal: "2026-10-05T09:00", allDay: false, instance: "" },
    ]);
    calendarMocks.mailCalDavSync.mockResolvedValue({ collection: "c", events: 2, errors: [] });
    const onStatus = vi.fn();
    const onChanged = vi.fn();
    render(<MailAgendaPanel info={info} onStatus={onStatus} onChanged={onChanged} />);
    const events = await screen.findAllByTestId("mail-agenda-event");
    expect(events.map((row) => row.dataset.summary)).toEqual(["Standup", "Review"]);
    expect(screen.getByText("Room 2")).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ uid: "a" })]));
    fireEvent.click(screen.getByTestId("mail-agenda-sync"));
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith("Calendar synced: 2 events in the next weeks"));
    expect(calendarMocks.mailListAgenda).toHaveBeenCalledTimes(2);
  });

  it("shows sync errors and the empty state", async () => {
    calendarMocks.mailListAgenda.mockResolvedValue([]);
    calendarMocks.mailCalDavSync.mockResolvedValue({ collection: "c", events: 0, errors: ["CalDAV REPORT returned 500"] });
    render(<MailAgendaPanel info={info} />);
    expect(await screen.findByTestId("mail-agenda-empty")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("mail-agenda-sync"));
    expect(await screen.findByTestId("mail-agenda-error")).toHaveTextContent("REPORT returned 500");
  });
});
