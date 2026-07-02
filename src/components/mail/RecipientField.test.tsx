import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecipientField } from "./RecipientField";
import type { ComposeRecipient, RecipientSuggestion } from "../../lib/mailRecipients";

function Harness({
  suggestions = [],
  defaultDomain = "yourmail.com",
  onQueryChange = vi.fn(),
}: {
  suggestions?: RecipientSuggestion[];
  defaultDomain?: string | null;
  onQueryChange?: (query: string) => void;
}) {
  const [recipients, setRecipients] = useState<ComposeRecipient[]>([]);
  return (
    <RecipientField
      id="recipient-to"
      label="To"
      recipients={recipients}
      suggestions={suggestions}
      defaultDomain={defaultDomain}
      dataTestId="mail-recipient-to"
      onChange={setRecipients}
      onQueryChange={onQueryChange}
    />
  );
}

describe("RecipientField", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("does not publish empty search queries while idle", () => {
    const onQueryChange = vi.fn();
    const { rerender } = render(<Harness onQueryChange={onQueryChange} />);

    expect(onQueryChange).not.toHaveBeenCalled();

    rerender(<Harness onQueryChange={onQueryChange} suggestions={[{
      name: "Ops",
      email: "ops@example.com",
      source: "history",
      score: 100,
      lastSeenAt: null,
    }]} />);

    expect(onQueryChange).not.toHaveBeenCalled();
  });

  it("accepts a cached contact suggestion with Enter", () => {
    render(<Harness suggestions={[{
      name: "Si Li",
      email: "si.li@yourmail.com",
      source: "history",
      score: 100,
      lastSeenAt: null,
    }]} />);

    const input = screen.getByLabelText("To");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "si" } });

    expect(screen.getByTestId("mail-recipient-suggestion")).toHaveTextContent("Si Li <si.li@yourmail.com>");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByTestId("mail-recipient-chip")).toHaveTextContent("Si Li <si.li@yourmail.com>");
  });

  it("offers the current account domain when cache has no match and Tab completes it", () => {
    render(<Harness suggestions={[]} />);

    const input = screen.getByLabelText("To");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "si.li@" } });

    expect(screen.getByTestId("mail-recipient-suggestion")).toHaveTextContent("si.li@yourmail.com");
    expect(screen.getByTestId("mail-recipient-suggestion")).toHaveTextContent("current domain");
    fireEvent.keyDown(input, { key: "Tab" });

    expect(screen.getByTestId("mail-recipient-chip")).toHaveTextContent("si.li@yourmail.com");
  });

  it("splits pasted recipient lists into chips", () => {
    render(<Harness />);

    const input = screen.getByLabelText("To");
    fireEvent.focus(input);
    fireEvent.paste(input, {
      clipboardData: {
        getData: () => "Ada <ada@example.com>, bob@example.com",
      },
    });

    const chips = screen.getAllByTestId("mail-recipient-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent("Ada <ada@example.com>");
    expect(chips[1]).toHaveTextContent("bob@example.com");
  });
});
