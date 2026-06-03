import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useRef } from "react";
import { useDbSessionFontSize } from "./useDbSessionFontSize";

function Harness({ visible = true }: { visible?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const { fontSize } = useDbSessionFontSize(visible, ref);
  return (
    <div ref={ref} data-testid="db-font-root">
      {fontSize}
    </div>
  );
}

describe("useDbSessionFontSize", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("uses terminal-style shortcuts for DB session font size", () => {
    render(<Harness />);

    expect(screen.getByTestId("db-font-root")).toHaveTextContent("13");

    fireEvent.keyDown(window, { key: "+", ctrlKey: true });
    expect(screen.getByTestId("db-font-root")).toHaveTextContent("14");
    expect(localStorage.getItem("taomni.db.sessionFontSize.v1")).toBe("14");

    fireEvent.keyDown(window, { key: "-", ctrlKey: true });
    expect(screen.getByTestId("db-font-root")).toHaveTextContent("13");

    fireEvent.keyDown(window, { key: "+", ctrlKey: true });
    fireEvent.keyDown(window, { key: "0", ctrlKey: true });
    expect(screen.getByTestId("db-font-root")).toHaveTextContent("13");
  });

  it("ignores shortcuts while the DB tab is hidden", () => {
    render(<Harness visible={false} />);

    fireEvent.keyDown(window, { key: "+", ctrlKey: true });
    expect(screen.getByTestId("db-font-root")).toHaveTextContent("13");
  });
});
