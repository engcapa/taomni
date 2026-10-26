import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useState } from "react";
import { BackupRangeEditor } from "./BackupRangeEditor";
import type { BackupRange } from "../../../lib/backup";
import { setLocale } from "../../../lib/i18n";

afterEach(cleanup);
function Editor({ initial }: { initial: BackupRange }) {
  const [value, setValue] = useState(initial);
  return <><BackupRangeEditor value={value} onChange={setValue} /><output data-testid="value">{JSON.stringify(value)}</output></>;
}
it("opens legacy full with explicit mail exclusion and keeps certificates when edited", () => {
  setLocale("en");
  render(<Editor initial={{ scope: "full", customOptions: { includeMail: false } }} />);
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.getByTestId("backup-global-include-mail")).not.toBeChecked();
  expect(screen.getByTestId("backup-global-includeLanchat")).toBeChecked();
  fireEvent.click(screen.getByTestId("backup-global-includeNotes"));
  expect(JSON.parse(screen.getByTestId("value").textContent!)).toMatchObject({ scope: "custom", customOptions: { includeNotes: false, includeMail: false, includeServerCertificates: true } });
});
it("shows mixed mail selection, toggles the whole branch and protects required cache", () => {
  render(<Editor initial={{ scope: "custom", customOptions: { includeMail: true, includeMailOriginals: false, includeMailAttachments: false } }} />);
  expect(screen.getByTestId("backup-global-include-mail")).toBePartiallyChecked();
  fireEvent.click(screen.getByTestId("backup-global-includeMailOriginals"));
  expect(screen.getByTestId("backup-global-includeMail")).toBeDisabled();
  expect(screen.getByTestId("backup-global-includeMailOriginals")).toBeChecked();
  fireEvent.click(screen.getByTestId("backup-global-include-mail"));
  expect(screen.getByTestId("backup-global-includeMailAttachments")).toBeChecked();
  fireEvent.click(screen.getByTestId("backup-global-include-mail"));
  expect(screen.getByTestId("backup-global-includeMail")).not.toBeChecked();
  expect(screen.getByTestId("backup-global-includeMailOriginals")).not.toBeChecked();
});
